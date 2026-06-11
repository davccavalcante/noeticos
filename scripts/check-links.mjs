#!/usr/bin/env node
/**
 * Launch link-check gate for README.md. Zero dependencies, plain Node.
 *
 * Extracts every absolute URL and every relative link target from README.md, then:
 * - verifies each relative target exists in the repository tree, and
 * - probes each absolute URL over HTTP (HEAD first, GET fallback) expecting a
 *   2xx or 3xx final status.
 *
 * Usage: node scripts/check-links.mjs [--skip-external]
 *   --skip-external  check only relative targets (offline and pre-push runs)
 *
 * Loopback URLs (localhost, 127.0.0.1, ::1) are documentation examples of the
 * serve bridge and are never probed. Hosts that bot-gate automated clients
 * (LinkedIn, X, PhilArchive: measured 403/999 for ANY non-browser client, even
 * for resources that exist) are probed, but a gate-shaped status (401, 403, 405,
 * 429, 999) counts as reachable; 404 and 410 still fail. www.npmjs.com package
 * pages sit behind the same gate, so they are probed against the public registry
 * API, which answers the same existence question honestly. The link to THIS
 * package's own npm page is skipped with a warning: release.yml (this gate) runs
 * before npm-publish.yml by design, so at the first release that page cannot
 * exist yet.
 *
 * Exit code 0 when every link checks out, 1 with one stderr line per failure.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = path.join(ROOT, 'README.md');
const SKIP_EXTERNAL = process.argv.includes('--skip-external');
const TIMEOUT_MS = 20000;
const USER_AGENT = 'noeticos-link-check/1.0 (release gate)';

const BOT_GATED_HOSTS = new Set([
  'linkedin.com',
  'www.linkedin.com',
  'x.com',
  'twitter.com',
  'philarchive.org',
  'philpeople.org',
]);
/** Statuses that mean "a gate answered", not "the resource is missing". */
const BOT_GATE_STATUSES = new Set([401, 403, 405, 429, 999]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const PACKAGE_NAME = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;
const NPM_PAGE_PREFIX = 'https://www.npmjs.com/package/';
const SELF_NPM_PAGE = `${NPM_PAGE_PREFIX}${PACKAGE_NAME}`;
// The package's canonical site host (family convention: <unscoped-name>.takk.ag).
// Until the Creator cuts the custom-domain DNS over, the host does not resolve at
// all; that exact state is pending by design and warns instead of failing. The
// moment DNS exists, any non-2xx answer fails the gate again, so the exception
// disarms itself at cutover and never excuses a broken live site.
const CANONICAL_SITE_HOST = `${PACKAGE_NAME.split('/')[1]}.takk.ag`;

const text = readFileSync(README, 'utf8');

// (1) Absolute URLs anywhere in the document, badges and code fences included.
const absolute = new Set();
for (const match of text.matchAll(/https?:\/\/[^\s)\]>"'`]+/g)) {
  absolute.add(match[0].replace(/[.,;:!?]+$/, ''));
}

// (2) Relative targets of markdown links and images plus html src/href attributes.
const relative = new Set();
const addRelative = (target) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) {
    return; // absolute URL, mailto:, or intra-document anchor
  }
  const bare = target.split('#')[0].split('?')[0];
  if (bare !== '') {
    relative.add(bare);
  }
};
for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
  addRelative(match[1]);
}
for (const match of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
  addRelative(match[1]);
}

const failures = [];

for (const target of [...relative].sort()) {
  const resolved = path.resolve(ROOT, target);
  const inside = !path.relative(ROOT, resolved).startsWith('..');
  if (!inside) {
    failures.push(`relative target escapes the repository: ${target}`);
  } else if (!existsSync(resolved)) {
    failures.push(`relative target missing from the tree: ${target}`);
  }
}

function isLoopback(url) {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Rewrites an npm package-page URL to the registry API equivalent: the registry
 * answers the same "does this package exist" question without the bot gate.
 */
function probeTarget(url) {
  if (url.startsWith(NPM_PAGE_PREFIX)) {
    const name = url.slice(NPM_PAGE_PREFIX.length).split('#')[0].split('?')[0];
    return `https://registry.npmjs.org/${name.split('/v/')[0]}`;
  }
  return url;
}

/** Probes one URL. Returns undefined on success, a failure line otherwise. */
async function probe(url) {
  const target = probeTarget(url);
  let lastFailure = `${url} unreachable`;
  for (const method of ['HEAD', 'GET']) {
    try {
      const response = await fetch(target, {
        method,
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT },
      });
      if (response.status < 400) {
        return undefined;
      }
      if (BOT_GATED_HOSTS.has(new URL(target).hostname) && BOT_GATE_STATUSES.has(response.status)) {
        process.stderr.write(
          `warn: ${url} answered ${response.status} (bot-gated host, counted reachable)\n`,
        );
        return undefined;
      }
      lastFailure = `${url} answered ${response.status} (${method})`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const causeCode =
        error instanceof Error && error.cause && typeof error.cause === 'object'
          ? Reflect.get(error.cause, 'code')
          : undefined;
      const dnsMiss = causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN';
      if (dnsMiss && new URL(target).hostname === CANONICAL_SITE_HOST) {
        process.stderr.write(
          `warn: ${url} pending by design (custom-domain DNS not configured yet; the gate re-arms once ${CANONICAL_SITE_HOST} resolves)\n`,
        );
        return undefined;
      }
      lastFailure = `${url} failed: ${message} (${method})`;
    }
  }
  return lastFailure;
}

const external = [...absolute]
  .filter((url) => !isLoopback(url))
  .filter((url) => {
    if (url === SELF_NPM_PAGE || url.startsWith(`${SELF_NPM_PAGE}/`)) {
      process.stderr.write(
        `warn: ${url} skipped (this package's own npm page; release.yml runs before npm-publish.yml)\n`,
      );
      return false;
    }
    return true;
  })
  .sort();
if (SKIP_EXTERNAL) {
  process.stdout.write(`skipping ${external.length} external URLs (--skip-external)\n`);
} else {
  const results = await Promise.all(external.map((url) => probe(url)));
  for (const failure of results) {
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`link-check: ${failure}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `link-check: ${relative.size} relative targets ok, ` +
      `${SKIP_EXTERNAL ? 0 : external.length} external URLs ok\n`,
  );
}
