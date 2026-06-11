/**
 * End-to-end tests of the `noeticos` CLI, executed against real subprocesses.
 *
 * CRITICAL HARNESS RULE (hard-learned in this package family): never spawn the tsx
 * wrapper binary (node_modules/.bin/tsx) for subprocesses whose exit codes or signal
 * behavior are asserted. The wrapper forks an inner node process, relays SIGINT to
 * it, and then exits 130 itself, masking the CLI's real exit code, so the serve
 * shutdown contract (SIGINT handler runs, process exits 0 with signal null) becomes
 * untestable. The loader is therefore always attached in-process:
 * spawn(process.execPath, ['--import', 'tsx', CLI, ...args]) launches plain node
 * with the tsx ESM hooks, and the asserted process IS the CLI process.
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30000 });

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli', 'index.ts');
const NODE = process.execPath;
const LOADER = ['--import', 'tsx'];

/** Pid-derived port so parallel CI shards never collide on the same listener. */
const SERVE_PORT = 19000 + (process.pid % 2000);

interface CliResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI to completion and resolves with its exit code and full stdio. */
function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [...LOADER, CLI, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** Child process shape with stdin ignored and stdout plus stderr piped. */
type CliChild = ChildProcessByStdio<null, Readable, Readable>;

interface ServeHandle {
  readonly child: CliChild;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Spawns `noeticos serve` and resolves once the exact listen line appears on
 * stdout. Rejects with the captured stderr when the process dies before listening.
 */
function startServe(port: number, extraArgs: readonly string[]): Promise<ServeHandle> {
  const listenLine = `noeticos serve listening on http://127.0.0.1:${port}\n`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      NODE,
      [...LOADER, CLI, 'serve', '--port', String(port), '--host', '127.0.0.1', ...extraArgs],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveClosed) => {
        child.on('close', (code, signal) => {
          resolveClosed({ code, signal });
        });
      },
    );
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(listenLine)) {
        resolve({ child, closed });
      }
    });
    child.on('error', reject);
    void closed.then(({ code, signal }) => {
      // No-op when the listen line already resolved the promise.
      reject(
        new Error(`serve exited before listening (code ${code}, signal ${signal}): ${stderr}`),
      );
    });
  });
}

/** Kills a serve child that is still alive after a failed test body. */
function reapIfAlive(handle: ServeHandle): void {
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill('SIGKILL');
  }
}

describe('noeticos cli', () => {
  it('help exits 0 and the first stdout line is exactly the public banner', async () => {
    const result = await runCli(['help']);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    // The exact first line is a public CI contract: tooling greps for it.
    expect(result.stdout.startsWith('noeticos 1.0.0')).toBe(true);
    expect(result.stdout.split('\n')[0]).toBe('noeticos 1.0.0');
    expect(result.stdout).toContain('simulate');
    expect(result.stdout).toContain('inspect');
    expect(result.stdout).toContain('serve');
  });

  it('version exits 0 printing exactly the package version, with flag aliases', async () => {
    for (const args of [['version'], ['--version'], ['-v']]) {
      const result = await runCli(args);
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      // Exact output is a CI contract: test.yml greps the version subcommand.
      expect(result.stdout).toBe('1.0.0\n');
      expect(result.stderr).toBe('');
    }
  });

  it('unknown command exits 2 with a stderr hint', async () => {
    const result = await runCli(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command "frobnicate"');
  });

  it('simulate is byte-identical per seed and diverges across seeds', async () => {
    const args = ['simulate', '--executions', '300', '--seed', '7'];
    const first = await runCli(args);
    const second = await runCli(args);
    const otherSeed = await runCli(['simulate', '--executions', '300', '--seed', '11']);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(otherSeed.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).toContain('--- summary ---');
    expect(first.stdout).toContain('executions: 300');
    expect(first.stdout).toMatch(/^decision canary\./m);
    expect(first.stdout).toContain('static baseline:');
    expect(first.stdout).toContain('noeticos tuned:');
    expect(otherSeed.stdout).not.toBe(first.stdout);
  });

  it('inspect reports a missing state path and exits 0', async () => {
    const missingPath = path.join(tmpdir(), `noeticos-cli-missing-${process.pid}.json`);
    const result = await runCli(['inspect', '--state', missingPath]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`no state found at ${missingPath}`);
  });

  it('serve answers the JSON bridge endpoints and exits 0 on SIGINT', async () => {
    const port = SERVE_PORT;
    const base = `http://127.0.0.1:${port}`;
    const handle = await startServe(port, []);
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const recommendResponse = await fetch(`${base}/recommend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'http-agent', kind: 'factual-qa' }),
      });
      expect(recommendResponse.status).toBe(200);
      const recommendation = (await recommendResponse.json()) as {
        executionId: string;
        parameters: Record<string, unknown>;
        cohort: string;
      };
      expect(typeof recommendation.executionId).toBe('string');
      expect(recommendation.executionId.length).toBeGreaterThan(0);
      expect(recommendation.parameters).toBeTypeOf('object');
      expect(Object.keys(recommendation.parameters).length).toBeGreaterThan(0);
      expect(['baseline', 'canary']).toContain(recommendation.cohort);

      const reportResponse = await fetch(`${base}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          executionId: recommendation.executionId,
          latencyMs: 800,
          costUsd: 0.002,
          qualityScore: 0.9,
        }),
      });
      expect(reportResponse.status).toBe(200);
      expect(await reportResponse.json()).toEqual({ ok: true });

      const profilesResponse = await fetch(`${base}/profiles?agentId=http-agent`);
      expect(profilesResponse.status).toBe(200);
      const profiles = (await profilesResponse.json()) as unknown[];
      expect(Array.isArray(profiles)).toBe(true);
      expect(profiles.length).toBeGreaterThan(0);

      const decisionsResponse = await fetch(`${base}/decisions`);
      expect(decisionsResponse.status).toBe(200);
      expect(Array.isArray(await decisionsResponse.json())).toBe(true);

      const notFound = await fetch(`${base}/nope`);
      expect(notFound.status).toBe(404);

      const malformed = await fetch(`${base}/recommend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"agentId":',
      });
      expect(malformed.status).toBe(400);

      // The SIGINT handler must run shutdown and exit 0; see the harness rule at
      // the top of this file for why the child must be plain node, not the tsx
      // wrapper binary.
      handle.child.kill('SIGINT');
      const exit = await handle.closed;
      expect(exit.code).toBe(0);
      expect(exit.signal).toBeNull();
    } finally {
      reapIfAlive(handle);
    }
  });

  it('serve enforces JSON content types, rejects empty agentId, and refuses preflight', async () => {
    const port = SERVE_PORT + 3;
    const base = `http://127.0.0.1:${port}`;
    const handle = await startServe(port, []);
    try {
      // Cross-origin "simple request" shapes (text and form POSTs) are refused
      // with 415 before any body is interpreted.
      const textPost = await fetch(`${base}/recommend`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ agentId: 'http-agent' }),
      });
      expect(textPost.status).toBe(415);
      expect(await textPost.json()).toEqual({ error: 'unsupported media type' });

      const formPost = await fetch(`${base}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'executionId=nx-1',
      });
      expect(formPost.status).toBe(415);

      // A charset parameter on the JSON content type stays accepted.
      const charset = await fetch(`${base}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ executionId: 'nx-unknown-id' }),
      });
      expect(charset.status).toBe(200);

      // Empty agentId is rejected with 400.
      const emptyAgent = await fetch(`${base}/recommend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: '' }),
      });
      expect(emptyAgent.status).toBe(400);

      // Without --cors-origin (and the token it requires) the preflight is
      // refused and no CORS header is ever emitted.
      const preflight = await fetch(`${base}/recommend`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://evil.example',
          'access-control-request-method': 'POST',
        },
      });
      expect(preflight.status).toBe(403);
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull();

      // /healthz stays unauthenticated and unaffected.
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      handle.child.kill('SIGINT');
      const exit = await handle.closed;
      expect(exit.code).toBe(0);
    } finally {
      reapIfAlive(handle);
    }
  });

  it('serve refuses a non-loopback host without --token and exits 1', async () => {
    const result = await runCli(['serve', '--host', '0.0.0.0', '--port', String(SERVE_PORT + 5)]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('non-loopback');
    expect(result.stderr).toContain('--token');
    expect(result.stderr).toContain('--insecure-no-token');
  });

  it('serve answers the CORS preflight only with --token and --cors-origin', async () => {
    const port = SERVE_PORT + 9;
    const base = `http://127.0.0.1:${port}`;
    const origin = 'http://127.0.0.1:5173';
    const handle = await startServe(port, ['--token', 'secret-2', '--cors-origin', origin]);
    try {
      const preflight = await fetch(`${base}/recommend`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
      expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
      expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');

      // The actual authenticated response also reflects the declared origin so a
      // browser dashboard can read it.
      const recommend = await fetch(`${base}/recommend`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret-2',
          origin,
        },
        body: JSON.stringify({ agentId: 'dashboard-agent', kind: 'planning' }),
      });
      expect(recommend.status).toBe(200);
      expect(recommend.headers.get('access-control-allow-origin')).toBe(origin);

      handle.child.kill('SIGINT');
      const exit = await handle.closed;
      expect(exit.code).toBe(0);
    } finally {
      reapIfAlive(handle);
    }
  });

  it('serve --token rejects missing and wrong tokens but never guards /healthz', async () => {
    const port = SERVE_PORT + 7;
    const base = `http://127.0.0.1:${port}`;
    const handle = await startServe(port, ['--token', 'secret-1']);
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const body = JSON.stringify({ agentId: 'http-agent', kind: 'factual-qa' });
      const withoutToken = await fetch(`${base}/recommend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(withoutToken.status).toBe(401);

      const wrongToken = await fetch(`${base}/recommend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer not-secret-1' },
        body,
      });
      expect(wrongToken.status).toBe(401);

      const rightToken = await fetch(`${base}/recommend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret-1' },
        body,
      });
      expect(rightToken.status).toBe(200);
      const recommendation = (await rightToken.json()) as { executionId: string };
      expect(typeof recommendation.executionId).toBe('string');

      handle.child.kill('SIGINT');
      const exit = await handle.closed;
      expect(exit.code).toBe(0);
      expect(exit.signal).toBeNull();
    } finally {
      reapIfAlive(handle);
    }
  });
});
