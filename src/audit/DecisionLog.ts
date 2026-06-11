import type { DecisionEntry } from '../types.js';

/**
 * Serialized form of a {@link DecisionLog}: the retained entries plus the sequence
 * counter, so a restored log never reuses sequence numbers of evicted entries.
 */
export interface DecisionLogJSON {
  /** Last sequence number assigned, equal to the total entries ever appended. */
  readonly seq: number;
  /** Retained entries in chronological order. */
  readonly entries: readonly DecisionEntry[];
}

/**
 * Append-only, capacity-bounded log of {@link DecisionEntry} records.
 *
 * Entries are frozen on append and never edited or deleted. When the capacity is
 * exceeded the oldest entries are evicted, but sequence numbers keep increasing
 * monotonically across evictions and serialization round trips.
 */
export class DecisionLog {
  private readonly capacity: number;
  private readonly entries: DecisionEntry[] = [];
  private seq = 0;

  constructor(capacity = 1000) {
    this.capacity = capacity;
  }

  /** Number of entries currently retained, at most the capacity. */
  get size(): number {
    return this.entries.length;
  }

  /** Total entries ever appended, including evicted ones. */
  get totalAppended(): number {
    return this.seq;
  }

  /**
   * Appends an entry, assigning the next sequence number starting at 1, and returns
   * the frozen record. Evicts the oldest entries beyond capacity.
   */
  append(entry: Omit<DecisionEntry, 'seq'>): DecisionEntry {
    this.seq += 1;
    const record: DecisionEntry = Object.freeze({ ...entry, seq: this.seq });
    this.entries.push(record);
    while (this.entries.length > this.capacity) {
      this.entries.shift();
    }
    return record;
  }

  /**
   * Returns retained entries in chronological order, optionally filtered by agent.
   * When `limit` is given, only the most recent `limit` matching entries are kept.
   */
  list(filter?: { agentId?: string; limit?: number }): readonly DecisionEntry[] {
    const agentId = filter?.agentId;
    const matched =
      agentId === undefined
        ? this.entries.slice()
        : this.entries.filter((entry) => entry.agentId === agentId);
    const limit = filter?.limit;
    if (limit === undefined) {
      return matched;
    }
    const keep = Math.max(0, Math.floor(limit));
    return keep >= matched.length ? matched : matched.slice(matched.length - keep);
  }

  /** Serializes the retained entries and the sequence counter. */
  toJSON(): DecisionLogJSON {
    return { seq: this.seq, entries: this.entries.slice() };
  }

  /** Restores a log from {@link DecisionLog.toJSON} output. */
  static fromJSON(json: DecisionLogJSON, capacity = 1000): DecisionLog {
    const log = new DecisionLog(capacity);
    // The counter must dominate every restored seq so future appends never reuse one.
    let seq = Math.max(0, Math.floor(json.seq));
    for (const entry of json.entries) {
      if (entry.seq > seq) {
        seq = entry.seq;
      }
      log.entries.push(Object.freeze({ ...entry }));
    }
    log.seq = seq;
    while (log.entries.length > log.capacity) {
      log.entries.shift();
    }
    return log;
  }
}
