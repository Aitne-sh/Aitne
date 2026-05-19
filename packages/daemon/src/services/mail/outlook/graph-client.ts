/**
 * Thin raw-fetch wrapper around Microsoft Graph v1.0 (§3.5).
 *
 * Why not the SDK: the official `@microsoft/microsoft-graph-client` is
 * unmaintained (last release ~3yr) and the new Kiota-based SDK is preview.
 * The mail surface we need is ~8 endpoints — wrapping fetch is less code
 * than adapting either SDK.
 *
 * The token-acquisition layer is injected (so unit tests don't need MSAL)
 * and the concurrency limiter respects Graph's per-(app,tenant) cap of 4
 * concurrent requests (§3.8) — we leave 1 of 4 for ad-hoc UI calls.
 */

export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

export type GraphMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface GraphTokenProvider {
  /** Returns a bearer access token. May trigger a silent refresh. */
  getAccessToken(): Promise<string>;
  /** Forces the next call to refresh — invoked when Graph returns 401. */
  invalidateToken(): void;
}

export interface GraphRequestInit {
  method?: GraphMethod;
  /** Either a path beginning with `/` (joined to GRAPH_BASE_URL) or an absolute URL. */
  url: string;
  body?: unknown;
  /** Extra headers — `Authorization` and `Content-Type` are always set internally. */
  headers?: Record<string, string>;
  /** Disable the 401 → invalidate-and-retry-once dance (used by the retry itself). */
  skipAuthRetry?: boolean;
  /** Per-call timeout signal; the caller is responsible for combining with cancellation. */
  signal?: AbortSignal;
}

export class GraphError extends Error {
  readonly httpStatus: number;
  readonly responseBody: string | null;
  readonly graphCode: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(opts: {
    message: string;
    httpStatus: number;
    responseBody: string | null;
    graphCode: string | null;
    retryAfterSeconds: number | null;
  }) {
    super(opts.message);
    this.name = "GraphError";
    this.httpStatus = opts.httpStatus;
    this.responseBody = opts.responseBody;
    this.graphCode = opts.graphCode;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

interface ParsedRetryAfter {
  seconds: number | null;
}

export function parseRetryAfter(headerValue: string | null, now: () => Date = () => new Date()): ParsedRetryAfter {
  if (!headerValue) return { seconds: null };
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return { seconds: Math.max(0, parseInt(trimmed, 10)) };
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    const diffMs = parsed - now().getTime();
    return { seconds: Math.max(0, Math.ceil(diffMs / 1000)) };
  }
  return { seconds: null };
}

export function resolveGraphUrl(urlOrPath: string, base: string = GRAPH_BASE_URL): string {
  if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
  if (urlOrPath.startsWith("/")) return `${base}${urlOrPath}`;
  return `${base}/${urlOrPath}`;
}

export function extractGraphError(body: unknown): { code: string | null; message: string | null } {
  if (!body || typeof body !== "object") return { code: null, message: null };
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return { code: null, message: null };
  const code = typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
  const message = typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : null;
  return { code, message };
}

interface PendingTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

/**
 * Bounded FIFO concurrency limiter. Used by GraphClient to cap simultaneous
 * Graph requests. Pure mechanism; no Graph-specific knowledge.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: PendingTask<unknown>[] = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error("ConcurrencyLimiter: maxConcurrent must be >= 1");
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run: task, resolve: resolve as (v: unknown) => void, reject });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      /* c8 ignore next 1 -- queue.length>0 above guarantees shift() returns; defensive only */
      if (!next) return;
      this.active++;
      next
        .run()
        .then((value) => next.resolve(value))
        .catch((err) => next.reject(err))
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }

}

export interface GraphClientOptions {
  tokenProvider: GraphTokenProvider;
  concurrency?: number;
  /** Override for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Cap on automatic 429 retries per request (default 1). */
  maxRetryAfterRetries?: number;
  /** Override `now` for testing Retry-After date math. */
  now?: () => Date;
  /**
   * Account-level AbortSignal (§3.2). Applied to every request when the caller
   * hasn't supplied its own `init.signal`. Used by the registry to cancel
   * in-flight polls on `removeAccount` / `setActive(false)`.
   */
  defaultSignal?: AbortSignal;
}

export class GraphClient {
  private readonly tokenProvider: GraphTokenProvider;
  private readonly limiter: ConcurrencyLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetryAfterRetries: number;
  private readonly now: () => Date;
  private readonly defaultSignal: AbortSignal | null;

  constructor(options: GraphClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.limiter = new ConcurrencyLimiter(options.concurrency ?? 3);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxRetryAfterRetries = options.maxRetryAfterRetries ?? 1;
    this.now = options.now ?? (() => new Date());
    this.defaultSignal = options.defaultSignal ?? null;
  }

  /** Issue a JSON-bodied request and parse the JSON response. */
  async requestJson<T = unknown>(init: GraphRequestInit): Promise<T> {
    return this.limiter.run(() => this.executeWithRetries<T>(init, 0));
  }

  /** Issue a request that does not have a JSON body. */
  async requestVoid(init: GraphRequestInit): Promise<void> {
    await this.limiter.run(() => this.executeWithRetries<void>(init, 0));
  }

  private async executeWithRetries<T>(init: GraphRequestInit, retryCount: number): Promise<T> {
    const token = await this.tokenProvider.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.headers ?? {}),
    };
    if (init.body !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    }

    const url = resolveGraphUrl(init.url);
    const signal = init.signal ?? this.defaultSignal ?? undefined;
    const response = await this.fetchImpl(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body),
      signal,
    });

    if (response.status === 401 && !init.skipAuthRetry) {
      this.tokenProvider.invalidateToken();
      return this.executeWithRetries<T>({ ...init, skipAuthRetry: true }, retryCount);
    }

    if (response.status === 429 || response.status === 503) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now);
      if (retryAfter.seconds !== null && retryCount < this.maxRetryAfterRetries) {
        await sleep(retryAfter.seconds * 1000);
        return this.executeWithRetries<T>(init, retryCount + 1);
      }
      // Fall through and surface as GraphError below.
    }

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      const parsed = bodyText ? safeParseJson(bodyText) : null;
      const { code, message } = extractGraphError(parsed);
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now);
      throw new GraphError({
        message: message ?? `Graph ${response.status} ${response.statusText}`,
        httpStatus: response.status,
        responseBody: bodyText,
        graphCode: code,
        retryAfterSeconds: retryAfter.seconds,
      });
    }

    if (response.status === 204) {
      return undefined as unknown as T;
    }

    const text = await safeReadText(response);
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }
}

async function safeReadText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
