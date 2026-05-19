/**
 * docs/design/appendices/opencode-backend.md §6.6.1 — HTTP Basic Auth `fetch` wrapper for
 * the Remote-mode `RemoteOpencodeServerManager` (and as a defense-in-depth
 * for Managed mode when `OPENCODE_SERVER_PASSWORD` is non-empty).
 *
 * Managed mode runs on loopback (`127.0.0.1`) and the spawned opencode
 * server in 1.14.50 does not enforce Basic Auth by default — but if the
 * operator's environment has a global `OPENCODE_SERVER_PASSWORD` set, the
 * server will require the header. Always wiring this wrapper means the
 * daemon stays correct under both setups without conditional plumbing.
 *
 * Phase 5 (Remote mode) is the primary consumer; in Phase 2 the wrapper
 * is constructed and exercised by the manager's `fetch` injection slot.
 */

export interface BasicAuthCredentials {
  username: string;
  password: string;
}

/**
 * Return a `fetch`-compatible function that adds an HTTP Basic Auth
 * `Authorization` header to every request when `credentials` is set.
 * When `credentials` is null/undefined, the underlying fetch is returned
 * unchanged — callers can wire this wrapper unconditionally without
 * sniffing the keychain at every call site.
 */
export function createBasicAuthFetch(
  credentials: BasicAuthCredentials | null | undefined,
  underlyingFetch: typeof fetch = fetch,
): typeof fetch {
  if (!credentials) return underlyingFetch;
  const { username, password } = credentials;
  if (!username || !password) return underlyingFetch;
  // RFC 7617 — username:password base64-encoded. Use Buffer to keep the
  // call usable in non-browser Node runtimes.
  const token = Buffer.from(`${username}:${password}`, "utf8").toString(
    "base64",
  );
  const authHeader = `Basic ${token}`;
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has("authorization")) {
      headers.set("authorization", authHeader);
    }
    return underlyingFetch(input, { ...init, headers });
  };
}
