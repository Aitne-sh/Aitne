export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    const record = body as Record<string, unknown> | null;
    const detail =
      typeof record?.message === "string"
        ? record.message
        : typeof record?.error === "string"
          ? record.error
          : `API Error ${status}`;
    super(detail);
    this.name = "ApiError";
  }
}

/**
 * Optional knobs for read-shaped calls. `params` populates the query
 * string; `headers` merges into the outbound `fetch` request. Both are
 * optional and backwards-compatible with the prior `Record<string,
 * string | number | undefined>` signature — TS structurally accepts an
 * object whose `params` is absent, so existing call sites that pass a
 * raw query-param record continue to compile via the overload below.
 */
export interface ApiRequestOptions {
  params?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
}

function isOptionsShape(value: unknown): value is ApiRequestOptions {
  if (!value || typeof value !== "object") return false;
  return "params" in value || "headers" in value;
}

function buildFetchInit(
  base: RequestInit,
  headers?: Record<string, string>,
): RequestInit {
  if (!headers) return base;
  const merged = { ...(base.headers ?? {}), ...headers };
  return { ...base, headers: merged };
}

class ApiClient {
  /**
   * GET helper. The second argument accepts either the legacy
   * query-param record (`Record<string, string | number | undefined>`)
   * or the structured options object (`{ params?, headers? }`). The
   * structured form lets the wiki dashboard pages send `x-process-key`,
   * which the daemon's auth layer requires on every `/api/wiki/*`
   * request.
   */
  async get<T>(
    path: string,
    paramsOrOptions?:
      | Record<string, string | number | undefined>
      | ApiRequestOptions,
  ): Promise<T> {
    const options: ApiRequestOptions = isOptionsShape(paramsOrOptions)
      ? paramsOrOptions
      : { params: paramsOrOptions };
    const url = new URL(`/api${path}`, window.location.origin);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), buildFetchInit({}, options.headers));
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res.json();
  }

  async post<T>(
    path: string,
    body?: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    const init = buildFetchInit(
      {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      },
      options?.headers,
    );
    const res = await fetch(`/api${path}`, init);
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res.json();
  }

  async put<T>(
    path: string,
    body: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    const init = buildFetchInit(
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      options?.headers,
    );
    const res = await fetch(`/api${path}`, init);
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res.json();
  }

  async patch<T>(
    path: string,
    body: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    const init = buildFetchInit(
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      options?.headers,
    );
    const res = await fetch(`/api${path}`, init);
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res.json();
  }

  async delete<T>(
    path: string,
    options?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<T> {
    // A JSON body is optional on DELETE — most callers omit it. The agents
    // hard-delete path sends `{ keep_history: false }`; the Next proxy
    // forwards the body verbatim for non-GET/HEAD methods.
    const hasBody = options?.body !== undefined;
    const init = buildFetchInit(
      {
        method: "DELETE",
        ...(hasBody
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(options!.body),
            }
          : {}),
      },
      options?.headers,
    );
    const res = await fetch(`/api${path}`, init);
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res.json();
  }

  async upload<T>(path: string, file: File, fieldName = "file"): Promise<T> {
    const formData = new FormData();
    formData.append(fieldName, file);
    const res = await fetch(`/api${path}`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res.json();
  }
}

export const api = new ApiClient();
