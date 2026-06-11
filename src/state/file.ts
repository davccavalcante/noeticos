import { NoeticosError } from '../errors.js';
import type { StateBackend, StateSnapshot } from '../types.js';

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * File-backed {@link StateBackend} for Node runtimes.
 *
 * Node built-ins are imported lazily inside each method so the core bundle stays
 * runtime-neutral for browser and edge consumers that never call this factory.
 * Saves are atomic: the snapshot is written to `path + '.tmp'` and then renamed.
 */
export function fileState(options: { path: string }): StateBackend {
  const { path } = options;
  return {
    async load(): Promise<StateSnapshot | undefined> {
      const fs = await import('node:fs/promises');
      let raw: string;
      try {
        raw = await fs.readFile(path, 'utf8');
      } catch (cause) {
        if (hasErrorCode(cause, 'ENOENT')) {
          return undefined;
        }
        throw new NoeticosError(
          `Failed to read state file at ${path}: ${describe(cause)}`,
          'ERR_STATE_LOAD',
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (cause) {
        throw new NoeticosError(
          `Failed to parse state file at ${path}: ${describe(cause)}`,
          'ERR_STATE_LOAD',
        );
      }
      if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) {
        throw new NoeticosError(
          `State file at ${path} is not a snapshot, missing version field`,
          'ERR_STATE_VERSION',
        );
      }
      if (parsed.version !== 1) {
        throw new NoeticosError(
          `State file at ${path} has unsupported version ${String(parsed.version)}, expected 1`,
          'ERR_STATE_VERSION',
        );
      }
      return parsed as StateSnapshot;
    },
    async save(snapshot: StateSnapshot): Promise<void> {
      const fs = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await fs.mkdir(dirname(path), { recursive: true });
      const tmpPath = `${path}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(snapshot), 'utf8');
      await fs.rename(tmpPath, path);
    },
  };
}
