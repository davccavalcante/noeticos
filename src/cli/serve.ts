/**
 * `noeticos serve`: a local HTTP bridge so non-Node runtimes can drive one shared
 * engine over JSON, the Hermes Agent ecosystem pattern where a Python gateway shells
 * out or webhooks into this process.
 *
 * Endpoints: GET /healthz (always unauthenticated), POST /recommend, POST /report,
 * GET /profiles, GET /decisions. When --token is set every endpoint except /healthz
 * requires `Authorization: Bearer <token>` (compared in constant time). Request
 * bodies are capped at 1 MB. With --state the learned state is flushed to disk
 * every 30 seconds and on shutdown.
 *
 * Hardening posture (loopback-open, network-closed):
 * - POST endpoints require `Content-Type: application/json` (415 otherwise), which
 *   blocks cross-origin "simple request" form and text POST poisoning from web pages.
 * - Binding a non-loopback host without --token is refused at startup (exit 1);
 *   --insecure-no-token overrides with a loud warning for closed-network setups.
 * - OPTIONS preflight answers 204 with CORS headers only when BOTH --token and
 *   --cors-origin are set; otherwise 403 with no CORS headers, so a browser page can
 *   never drive a tokenless bridge.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { clearInterval, setInterval } from 'node:timers';
import { DEFAULT_TASK_KINDS } from '../classify/TaskClassifier.js';
import { createNoeticOS } from '../core/createNoeticOS.js';
import { fileState } from '../state/file.js';
import type {
  ExecutionOutcome,
  NoeticOS,
  ObjectivePreset,
  TaskDescriptor,
  TaskKind,
  ToolCallOutcome,
} from '../types.js';
import { parseArgs } from './args.js';

const DEFAULT_PORT = 4377;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const FLUSH_INTERVAL_MS = 30_000;

const OBJECTIVES: readonly ObjectivePreset[] = ['balanced', 'cost', 'latency', 'quality'];

const FINISH_REASONS: readonly NonNullable<ExecutionOutcome['finishReason']>[] = [
  'stop',
  'length',
  'tool-calls',
  'content-filter',
  'error',
  'other',
];

const VALID_FLAGS: ReadonlySet<string> = new Set([
  'port',
  'host',
  'token',
  'cors-origin',
  'insecure-no-token',
  'state',
  'seed',
  'objective',
]);

/** Hosts the bridge may bind without a token. Everything else requires --token. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

interface ServeContext {
  readonly engine: NoeticOS;
  readonly token: string | undefined;
  readonly corsOrigin: string | undefined;
}

function fail(message: string): number {
  process.stderr.write(`noeticos serve: ${message}\n`);
  return 2;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** True when the content type is JSON: `application/json` with optional parameters. */
function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) {
    return false;
  }
  const mime = (header.split(';', 1)[0] ?? '').trim().toLowerCase();
  return mime === 'application/json';
}

/** Extracts the bearer credential from an Authorization header, if any. */
function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith('Bearer ')) {
    return undefined;
  }
  return header.slice('Bearer '.length);
}

/**
 * Constant-time token comparison. Both sides are hashed to fixed-length digests
 * first so `timingSafeEqual` never throws on length mismatch and the comparison
 * leaks neither content nor length of the expected token.
 */
function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) {
    return false;
  }
  const expectedDigest = createHash('sha256').update(expected).digest();
  const presentedDigest = createHash('sha256').update(presented).digest();
  return timingSafeEqual(expectedDigest, presentedDigest);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Reads the request body up to {@link MAX_BODY_BYTES}. Returns undefined when the
 * request failed or was over the cap, in which case the 413 response has already been
 * written and the connection destroyed.
 */
function readBody(request: IncomingMessage, response: ServerResponse): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    request.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'payload too large' }), () => {
          request.destroy();
        });
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      finish(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', () => {
      finish(undefined);
    });
    request.on('close', () => {
      finish(undefined);
    });
  });
}

type BodyRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/** Reads and parses a JSON body; on failure the error response is already sent. */
async function readJsonBody(request: IncomingMessage, response: ServerResponse): Promise<BodyRead> {
  const raw = await readBody(request, response);
  if (raw === undefined) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    sendJson(response, 400, { error: 'invalid json' });
    return { ok: false };
  }
}

function toTaskDescriptor(agentId: string, payload: Record<string, unknown>): TaskDescriptor {
  const kind = DEFAULT_TASK_KINDS.find((candidate) => candidate === payload.kind);
  const promptLength = asFiniteNumber(payload.promptLength);
  const toolsAvailable = asFiniteNumber(payload.toolsAvailable);
  const metadata = asMetadata(payload.metadata);
  return {
    agentId,
    ...(kind === undefined ? {} : { kind }),
    ...(typeof payload.prompt === 'string' ? { prompt: payload.prompt } : {}),
    ...(promptLength === undefined ? {} : { promptLength }),
    ...(toolsAvailable === undefined ? {} : { toolsAvailable }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function asMetadata(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      metadata[key] = entry;
    }
  }
  return metadata;
}

function asToolCalls(value: unknown): readonly ToolCallOutcome[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const calls: ToolCallOutcome[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.ok !== 'boolean') {
      continue;
    }
    calls.push({
      name: item.name,
      ok: item.ok,
      ...(typeof item.argumentsHash === 'string' ? { argumentsHash: item.argumentsHash } : {}),
    });
  }
  return calls;
}

function toExecutionOutcome(
  executionId: string,
  payload: Record<string, unknown>,
): ExecutionOutcome {
  const latencyMs = asFiniteNumber(payload.latencyMs);
  const costUsd = asFiniteNumber(payload.costUsd);
  const inputTokens = asFiniteNumber(payload.inputTokens);
  const outputTokens = asFiniteNumber(payload.outputTokens);
  const turns = asFiniteNumber(payload.turns);
  const qualityScore = asFiniteNumber(payload.qualityScore);
  const timestamp = asFiniteNumber(payload.timestamp);
  const finishReason = FINISH_REASONS.find((reason) => reason === payload.finishReason);
  const toolCalls = asToolCalls(payload.toolCalls);
  return {
    executionId,
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(turns === undefined ? {} : { turns }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(payload.error === true ? { error: true } : {}),
    ...(qualityScore === undefined ? {} : { qualityScore }),
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

async function handleRecommend(
  engine: NoeticOS,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request, response);
  if (!body.ok) {
    return;
  }
  const payload = body.value;
  if (!isRecord(payload) || typeof payload.agentId !== 'string' || payload.agentId === '') {
    sendJson(response, 400, { error: 'agentId required' });
    return;
  }
  sendJson(response, 200, engine.recommend(toTaskDescriptor(payload.agentId, payload)));
}

async function handleReport(
  engine: NoeticOS,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request, response);
  if (!body.ok) {
    return;
  }
  const payload = body.value;
  if (!isRecord(payload) || typeof payload.executionId !== 'string' || payload.executionId === '') {
    sendJson(response, 400, { error: 'executionId required' });
    return;
  }
  engine.report(toExecutionOutcome(payload.executionId, payload));
  sendJson(response, 200, { ok: true });
}

function handleProfiles(engine: NoeticOS, url: URL, response: ServerResponse): void {
  const agentId = url.searchParams.get('agentId');
  if (agentId === null || agentId === '') {
    sendJson(response, 400, { error: 'agentId required' });
    return;
  }
  const kindParam = url.searchParams.get('kind');
  let kind: TaskKind | undefined;
  if (kindParam !== null) {
    kind = DEFAULT_TASK_KINDS.find((candidate) => candidate === kindParam);
    if (kind === undefined) {
      sendJson(response, 400, { error: 'invalid kind' });
      return;
    }
  }
  sendJson(response, 200, engine.profileOf(agentId, kind));
}

function handleDecisions(engine: NoeticOS, url: URL, response: ServerResponse): void {
  const agentId = url.searchParams.get('agentId');
  const limitParam = url.searchParams.get('limit');
  let limit: number | undefined;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1) {
      sendJson(response, 400, { error: 'invalid limit' });
      return;
    }
    limit = parsed;
  }
  const filter = {
    ...(agentId === null || agentId === '' ? {} : { agentId }),
    ...(limit === undefined ? {} : { limit }),
  };
  sendJson(response, 200, engine.decisions(filter));
}

async function handleRequest(
  context: ServeContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (context.corsOrigin !== undefined) {
      // Reflected on every response so a browser dashboard on the declared origin
      // can read them. Never set without --token: runServe refuses that combination.
      response.setHeader('access-control-allow-origin', context.corsOrigin);
    }
    if (method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'OPTIONS') {
      // Preflight runs before the bearer check because browsers never attach
      // Authorization to OPTIONS. Without an explicit --cors-origin (and the token
      // it requires) the preflight is refused and no CORS header is emitted, so a
      // hostile web page cannot drive a tokenless local bridge.
      if (context.token !== undefined && context.corsOrigin !== undefined) {
        response.writeHead(204, {
          'access-control-allow-origin': context.corsOrigin,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '600',
        });
        response.end();
        return;
      }
      sendJson(response, 403, { error: 'cross-origin preflight refused' });
      return;
    }
    if (
      context.token !== undefined &&
      !tokenMatches(context.token, bearerOf(request.headers.authorization))
    ) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    if (method === 'POST' && (url.pathname === '/recommend' || url.pathname === '/report')) {
      if (!isJsonContentType(request.headers['content-type'])) {
        // Cross-origin "simple requests" (form and text POSTs) carry non-JSON
        // content types and never trigger a preflight; refusing them here closes
        // that poisoning channel even on a tokenless loopback bridge.
        sendJson(response, 415, { error: 'unsupported media type' });
        return;
      }
      if (url.pathname === '/recommend') {
        await handleRecommend(context.engine, request, response);
      } else {
        await handleReport(context.engine, request, response);
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/profiles') {
      handleProfiles(context.engine, url, response);
      return;
    }
    if (method === 'GET' && url.pathname === '/decisions') {
      handleDecisions(context.engine, url, response);
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  } catch {
    if (response.headersSent) {
      response.end();
    } else {
      sendJson(response, 500, { error: 'internal error' });
    }
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

type StringRead =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly error: string };

function readString(flags: ReadonlyMap<string, string | boolean>, name: string): StringRead {
  const raw = flags.get(name);
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, error: `flag --${name} requires a value` };
  }
  return { ok: true, value: raw };
}

/** Runs the serve command and returns the process exit code. */
export async function runServe(argv: readonly string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const unexpected = positional[0];
  if (unexpected !== undefined) {
    return fail(`unexpected argument "${unexpected}"`);
  }
  for (const name of flags.keys()) {
    if (!VALID_FLAGS.has(name)) {
      return fail(`unknown flag "--${name}"`);
    }
  }
  const portRead = readString(flags, 'port');
  if (!portRead.ok) {
    return fail(portRead.error);
  }
  let port = DEFAULT_PORT;
  if (portRead.value !== undefined) {
    port = Number(portRead.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return fail(`--port expects an integer in [1, 65535], got "${portRead.value}"`);
    }
  }
  const hostRead = readString(flags, 'host');
  if (!hostRead.ok) {
    return fail(hostRead.error);
  }
  const host = hostRead.value ?? DEFAULT_HOST;
  const tokenRead = readString(flags, 'token');
  if (!tokenRead.ok) {
    return fail(tokenRead.error);
  }
  const token = tokenRead.value;
  const corsRead = readString(flags, 'cors-origin');
  if (!corsRead.ok) {
    return fail(corsRead.error);
  }
  const corsOrigin = corsRead.value;
  const insecureFlag = flags.get('insecure-no-token');
  if (insecureFlag !== undefined && insecureFlag !== true) {
    return fail('flag --insecure-no-token takes no value');
  }
  const insecureNoToken = insecureFlag === true;
  if (corsOrigin !== undefined && token === undefined) {
    return fail(
      '--cors-origin requires --token: browser origins may only reach an authenticated bridge',
    );
  }
  const stateRead = readString(flags, 'state');
  if (!stateRead.ok) {
    return fail(stateRead.error);
  }
  const statePath = stateRead.value;
  const seedRead = readString(flags, 'seed');
  if (!seedRead.ok) {
    return fail(seedRead.error);
  }
  let seed: number | undefined;
  if (seedRead.value !== undefined) {
    seed = Number(seedRead.value);
    if (!Number.isFinite(seed)) {
      return fail(`--seed expects a number, got "${seedRead.value}"`);
    }
  }
  const objectiveRead = readString(flags, 'objective');
  if (!objectiveRead.ok) {
    return fail(objectiveRead.error);
  }
  let objective: ObjectivePreset | undefined;
  if (objectiveRead.value !== undefined) {
    objective = OBJECTIVES.find((preset) => preset === objectiveRead.value);
    if (objective === undefined) {
      return fail(
        `--objective expects balanced | cost | latency | quality, got "${objectiveRead.value}"`,
      );
    }
  }

  if (!LOOPBACK_HOSTS.has(host) && token === undefined) {
    if (!insecureNoToken) {
      process.stderr.write(
        `noeticos serve: refusing to bind non-loopback host "${host}" without --token. ` +
          'Anyone who can reach that address could drive the engine and poison its ' +
          'learned state. Add --token <secret>, or pass --insecure-no-token to ' +
          'override knowingly.\n',
      );
      return 1;
    }
    process.stderr.write(
      `noeticos serve: WARNING: binding non-loopback host "${host}" WITHOUT a token ` +
        'because --insecure-no-token was passed. Every endpoint is open to anyone ' +
        'who can reach this address.\n',
    );
  }

  const engine = createNoeticOS({
    ...(seed === undefined ? {} : { seed }),
    ...(objective === undefined ? {} : { objective }),
    ...(statePath === undefined ? {} : { state: fileState({ path: statePath }) }),
  });
  const context: ServeContext = { engine, token, corsOrigin };
  const server = createServer((request, response) => {
    void handleRequest(context, request, response);
  });

  // Periodic best-effort persistence; unref'd so the timer never holds the loop open.
  const flushTimer = setInterval(() => {
    void engine.flush();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(flushTimer);
    server.closeIdleConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    // close() flushes the learned state to the configured backend.
    await engine.close();
    process.exit(0);
  };
  // Signal handlers are registered before listen so an early signal still shuts
  // the process down cleanly.
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });

  try {
    await listen(server, port, host);
  } catch (error) {
    process.stderr.write(`noeticos serve: ${describe(error)}\n`);
    return 1;
  }
  process.stdout.write(`noeticos serve listening on http://${host}:${port}\n`);
  return 0;
}
