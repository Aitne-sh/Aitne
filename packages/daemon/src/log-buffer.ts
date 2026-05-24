/**
 * In-memory circular buffer for application logs.
 *
 * Captures info+ Pino log entries and makes them available via:
 * - REST: GET /api/logs (recent buffered entries)
 * - SSE:  GET /api/logs/stream (real-time push)
 *
 * The buffer is intentionally ephemeral — daemon restart clears it.
 * This is a dashboard convenience, not a durable audit trail.
 */

import type { LogEntry } from "@aitne/shared";

export type { LogEntry };

type LogSubscriber = (entry: LogEntry) => void;

const PINO_LEVEL_NAMES: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const MIN_BUFFER_LEVEL = 30; // info

/**
 * O(1) circular buffer for log entries.
 *
 * Uses a fixed-size array with a write pointer instead of Array.shift()
 * to avoid O(n) re-indexing on every eviction.
 */
export class LogBuffer {
  private readonly slots: (LogEntry | undefined)[];
  private head = 0; // next write position
  private count = 0;
  // Seed `nextId` from wall-clock so a daemon restart doesn't reuse low IDs
  // that a dashboard's stale `afterId` would treat as "old". Multiplying by
  // 1000 leaves headroom for ~9e15 entries before exceeding Number.MAX_SAFE,
  // and a SQLite REAL field would cap earlier anyway.
  private nextId = Date.now();
  private readonly subscribers = new Set<LogSubscriber>();
  private readonly loggerNameSet = new Set<string>();
  private broadcasting = false; // re-entrancy guard

  constructor(private readonly maxSize = 1000) {
    this.slots = new Array<LogEntry | undefined>(maxSize);
  }

  push(entry: Omit<LogEntry, "id">): void {
    const logEntry: LogEntry = { ...entry, id: this.nextId++ };

    this.slots[this.head] = logEntry;
    this.head = (this.head + 1) % this.maxSize;
    if (this.count < this.maxSize) this.count++;

    this.loggerNameSet.add(entry.logger);

    // Notify subscribers with re-entrancy guard.
    // If a subscriber triggers a log (e.g. SSE logger), the nested
    // pushToLogBuffer call will still buffer the entry but skip
    // broadcasting to prevent infinite recursion.
    if (!this.broadcasting) {
      this.broadcasting = true;
      try {
        for (const sub of this.subscribers) {
          try {
            sub(logEntry);
          } catch {
            /* subscriber errors must not crash the logger */
          }
        }
      } finally {
        this.broadcasting = false;
      }
    }
  }

  getRecent(
    limit = 200,
    filter?: { level?: string; logger?: string; afterId?: number },
  ): LogEntry[] {
    const result: LogEntry[] = [];
    // Read entries oldest-first from the circular buffer
    const start = this.count < this.maxSize ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.maxSize;
      const entry = this.slots[idx];
      // Defensive: every slot in [0, count) is filled after a push.
      /* c8 ignore next */
      if (!entry) continue;
      if (filter?.afterId && entry.id <= filter.afterId) continue;
      if (filter?.level && entry.level !== filter.level) continue;
      if (filter?.logger && entry.logger !== filter.logger) continue;
      result.push(entry);
    }
    // Return only the last `limit` entries (newest)
    return result.length > limit ? result.slice(-limit) : result;
  }

  /** Returns distinct logger names seen so far (O(1) — maintained incrementally). */
  getLoggerNames(): string[] {
    return [...this.loggerNameSet].sort();
  }

  clear(): void {
    this.slots.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.nextId = 1;
    this.loggerNameSet.clear();
  }

  subscribe(fn: LogSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  get size(): number {
    return this.count;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

// ── Global singleton ──

let globalBuffer: LogBuffer | null = null;

export function getLogBuffer(): LogBuffer {
  if (!globalBuffer) {
    globalBuffer = new LogBuffer(1000);
  }
  return globalBuffer;
}

/** Reset the global buffer — for tests only. */
export function resetLogBuffer(): void {
  globalBuffer = null;
}

export function clearLogBuffer(): void {
  getLogBuffer().clear();
}

/**
 * Called from Pino's logMethod hook to capture each log entry.
 * Only info (30) and above are buffered.
 *
 * IMPORTANT: `args` are already sanitized (Errors → plain objects,
 * secrets redacted) by the time this is called from the logMethod hook.
 */
export function pushToLogBuffer(
  level: number,
  loggerName: string,
  args: unknown[],
): void {
  if (level < MIN_BUFFER_LEVEL) return;

  const buffer = getLogBuffer();
  const { message, data } = extractLogParts(args);

  buffer.push({
    timestamp: new Date().toISOString(),
    // Defensive: only known Pino levels (10/20/30/40/50/60) reach this code;
    // the `?? "info"` is registry-drift insurance for a future custom level.
    /* c8 ignore next */
    level: PINO_LEVEL_NAMES[level] ?? "info",
    logger: loggerName,
    message,
    data: Object.keys(data).length > 0 ? data : undefined,
  });
}

// ── Helpers ──

/**
 * Extract the human-readable message and structured data from Pino args.
 *
 * Note: args have already been through sanitizeLogArg, so Errors are
 * plain objects `{ type, message, stack, ... }` — not Error instances.
 *
 * Pino calling conventions (post-sanitization):
 * - logger.info('message')                    -> ['message']
 * - logger.info({ key: 'val' }, 'message')    -> [{ key: 'val' }, 'message']
 * - logger.info(err, 'message')               -> [{ type, message, stack }, 'message']
 * - logger.info('hello %s', name)             -> ['hello %s', name]
 */
export function extractLogParts(args: unknown[]): {
  message: string;
  data: Record<string, unknown>;
} {
  if (args.length === 0) return { message: "", data: {} };

  if (args.length === 1) {
    if (typeof args[0] === "string") return { message: args[0], data: {} };
    if (typeof args[0] === "object" && args[0] !== null) {
      const obj = args[0] as Record<string, unknown>;
      const msg = typeof obj.msg === "string" ? obj.msg : "";
      return { message: msg, data: obj };
    }
    return { message: String(args[0]), data: {} };
  }

  const first = args[0];

  // Format string: logger.info('hello %s %d', name, count)
  if (typeof first === "string") {
    return { message: args.map(String).join(" "), data: {} };
  }

  // Merge object + message: logger.info({ key: 'val' }, 'message')
  const message =
    typeof args[args.length - 1] === "string"
      ? (args[args.length - 1] as string)
      : "";

  const data: Record<string, unknown> = {};
  if (typeof first === "object" && first !== null) {
    // Copy properties, skip 'msg' which is redundant with the message string
    for (const [k, v] of Object.entries(first as Record<string, unknown>)) {
      if (k !== "msg") data[k] = v;
    }
  }

  return { message, data };
}
