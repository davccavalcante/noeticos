/**
 * `noeticos` command dispatcher.
 *
 * Commands: help (also -h, --help, and the default with no arguments), version (also
 * --version and -v), simulate, inspect, serve. Unknown commands print a hint to
 * stderr and exit with code 2. The dispatcher owns nothing but routing: every command
 * module parses its own flags and returns its process exit code.
 */

import { runInspect } from './inspect.js';
import { runServe } from './serve.js';
import { runSimulate } from './simulate.js';

/**
 * Single source of truth for the version the CLI reports: the help banner first line
 * and the `version` command both print it, and CI greps for it.
 */
const VERSION = '1.0.0';

const HELP_TEXT = [
  `noeticos ${VERSION}`,
  '',
  'NoeticOS: adaptive runtime intelligence for production agents, per-task-class parameter tuning with confidence-bound bandits, deterministic canary rollouts, automatic rollback, and a complete decision audit log.',
  '',
  'Usage:',
  '  noeticos <command> [flags]',
  '',
  'Commands:',
  '  simulate    Deterministic synthetic workload demonstrating that tuning pays.',
  '    --executions <n>     number of synthetic executions (default 600)',
  '    --seed <n>           PRNG seed, one seed yields one byte-identical transcript (default 7)',
  '    --objective <name>   balanced | cost | latency | quality (default balanced)',
  '    --canary-share <x>   fraction of executions in the canary cohort (default 0.1)',
  '    example: noeticos simulate --executions 600 --seed 7',
  '',
  '  inspect     Human-readable view of a saved state snapshot.',
  '    --state <path>       path of the snapshot file (required)',
  '    example: noeticos inspect --state ./noeticos-state.json',
  '',
  '  serve       Local HTTP bridge exposing the engine to non-Node runtimes.',
  '    --port <n>           listen port (default 4377)',
  '    --host <address>     listen host (default 127.0.0.1); non-loopback hosts require --token',
  '    --token <secret>     require "Authorization: Bearer <secret>" except on GET /healthz',
  '    --cors-origin <o>    answer browser preflight for this origin (requires --token)',
  '    --insecure-no-token  override the non-loopback refusal without a token (dangerous)',
  '    --state <path>       persist learned state to this file',
  '    --seed <n>           engine PRNG seed (default 7)',
  '    --objective <name>   balanced | cost | latency | quality (default balanced)',
  '    example: noeticos serve --port 4377 --token secret --state ./noeticos-state.json',
  '',
  '  version     Print the package version. Aliases: --version, -v.',
  '',
  '  help        Print this message.',
].join('\n');

function isHelpCommand(command: string | undefined): boolean {
  return command === undefined || command === 'help' || command === '-h' || command === '--help';
}

function isVersionCommand(command: string | undefined): boolean {
  return command === 'version' || command === '--version' || command === '-v';
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (isHelpCommand(command)) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  if (isVersionCommand(command)) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const rest = argv.slice(1);
  if (command === 'simulate') {
    return runSimulate(rest);
  }
  if (command === 'inspect') {
    return await runInspect(rest);
  }
  if (command === 'serve') {
    return await runServe(rest);
  }
  process.stderr.write(`noeticos: unknown command "${command}". Run "noeticos help".\n`);
  return 2;
}

void main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`noeticos: ${message}\n`);
    process.exitCode = 1;
  },
);
