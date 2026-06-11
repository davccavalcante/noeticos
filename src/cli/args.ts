/**
 * Deterministic flag parser for the `noeticos` CLI.
 *
 * Supports `--key value`, `--key=value`, and bare boolean flags. A token that looks
 * like a flag is never consumed as the value of the preceding flag, so `--a --b`
 * yields two bare flags. Later occurrences of a flag overwrite earlier ones, and the
 * literal token `--` is kept as a positional. Pure module: no Node imports, no
 * globals, fully unit-testable.
 */

/** True when `token` has the shape of a `--flag` token. */
function isFlagToken(token: string): boolean {
  return token.startsWith('--') && token.length > 2;
}

/**
 * Parses an argv slice into positional tokens and a flag map. Bare flags map to
 * `true`, valued flags map to their raw string value.
 */
export function parseArgs(argv: readonly string[]): {
  positional: string[];
  flags: Map<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (!isFlagToken(token)) {
      positional.push(token);
      index += 1;
      continue;
    }
    const equals = token.indexOf('=');
    if (equals !== -1) {
      flags.set(token.slice(2, equals), token.slice(equals + 1));
      index += 1;
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || isFlagToken(next)) {
      flags.set(key, true);
      index += 1;
    } else {
      flags.set(key, next);
      index += 2;
    }
  }
  return { positional, flags };
}
