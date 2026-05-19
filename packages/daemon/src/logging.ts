import pino, { type DestinationStream, type LoggerOptions } from "pino";
import { redactString, SENSITIVE_KEY_PATTERN } from "./secrets/redaction.js";
import { pushToLogBuffer } from "./log-buffer.js";

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";

const VALID_LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

/** Resolve log level from PA_LOG_LEVEL env var. Falls back to "info". */
function resolveLogLevel(): string {
  const raw = process.env.PA_LOG_LEVEL?.trim().toLowerCase();
  if (raw && VALID_LOG_LEVELS.has(raw)) {
    return raw;
  }
  return "info";
}

/** Serialize an Error to a plain object, preserving custom properties (code, statusCode, etc.). */
function serializeError(err: Error, seen: WeakSet<object>): Record<string, unknown> {
  seen.add(err);
  const obj: Record<string, unknown> = {
    type: err.name,
    message: redactString(err.message, REDACTED),
    stack: err.stack ? redactString(err.stack, REDACTED) : undefined,
  };
  for (const [key, val] of Object.entries(err)) {
    if (key === "message" || key === "stack" || key === "name") continue;
    obj[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactLogValue(val, seen);
  }
  // cause is non-enumerable on most engines
  if (err.cause !== undefined && !("cause" in obj)) {
    obj.cause = redactLogValue(err.cause, seen);
  }
  return obj;
}

/**
 * Single-pass recursive redaction for log arguments.
 *
 * - Strings: regex-match known secret value patterns (Bearer tokens, API keys, etc.)
 * - Errors:  serialize to plain object with type/message/stack + custom props
 * - Dates:   convert to ISO string
 * - Map/Set: convert to object/array then recurse
 * - Objects: censor values whose key matches SENSITIVE_KEY_PATTERN, recurse into children
 *
 * A `WeakSet` tracks visited objects to prevent stack overflow on circular references.
 */
function redactLogValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value, REDACTED);
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  // --- object types below this point ---

  if (value instanceof Error) {
    return seen.has(value) ? CIRCULAR : serializeError(value, seen);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (ArrayBuffer.isView(value)) {
    return `<${value.constructor.name} length=${value.byteLength}>`;
  }

  // Circular reference guard
  if (seen.has(value as object)) return CIRCULAR;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redactLogValue(v, seen));
  }
  if (value instanceof Map) {
    const next: Record<string, unknown> = {};
    for (const [k, v] of value) {
      const key = String(k);
      next[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactLogValue(v, seen);
    }
    return next;
  }
  if (value instanceof Set) {
    return [...value].map((v) => redactLogValue(v, seen));
  }

  // Plain objects (and anything else that survives to here)
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactLogValue(child, seen);
  }
  return next;
}

export function createLogger(
  name: string,
  options: LoggerOptions = {},
  destination?: DestinationStream,
) {
  const externalLogMethod = options.hooks?.logMethod;

  return pino(
    {
      level: resolveLogLevel(),
      ...options,
      name,
      // Errors are fully serialized + redacted in the logMethod hook, so
      // bypass Pino's default errSerializer which would re-wrap our plain
      // object and clobber the `type` field with "Object".
      serializers: {
        err: (val: unknown) => val,
        ...options.serializers,
      },
      hooks: {
        ...options.hooks,
        logMethod(
          this: unknown,
          args: unknown[],
          method: (...innerArgs: unknown[]) => void,
          level: number,
        ) {
          const sanitizedArgs = args.map(sanitizeLogArg);
          // Push redacted log entry to the in-memory buffer for dashboard viewing
          pushToLogBuffer(level, name, sanitizedArgs);
          if (typeof externalLogMethod === "function") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pino custom method signature
            return (externalLogMethod as any).call(this, sanitizedArgs, method, level);
          }
          return method.apply(this as never, sanitizedArgs);
        },
      },
    },
    destination,
  );
}

export function sanitizeLogArg(arg: unknown): unknown {
  return redactLogValue(arg, new WeakSet());
}

export function toSafeErrorMessage(
  error: unknown,
  fallback = "Internal error",
): string {
  if (error instanceof Error && error.message.trim()) {
    return redactString(error.message, REDACTED);
  }
  if (typeof error === "string" && error.trim()) {
    return redactString(error, REDACTED);
  }
  return fallback;
}
