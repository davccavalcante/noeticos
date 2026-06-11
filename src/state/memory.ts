import type { StateBackend, StateSnapshot } from '../types.js';

/**
 * In-memory {@link StateBackend} holding the latest snapshot in a closure variable.
 * State lives as long as the backend instance and is never written anywhere else.
 */
export function memoryState(): StateBackend {
  let snapshot: StateSnapshot | undefined;
  return {
    load(): Promise<StateSnapshot | undefined> {
      return Promise.resolve(snapshot);
    },
    save(next: StateSnapshot): Promise<void> {
      snapshot = next;
      return Promise.resolve();
    },
  };
}
