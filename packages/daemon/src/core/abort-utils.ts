/**
 * Race a promise against an AbortSignal so the returned promise rejects
 * when the signal fires, even if the underlying work doesn't natively
 * honor the signal.
 *
 * Use this to wrap SDK calls (Notion, Google Calendar Node SDK, etc.)
 * whose signal support is uncertain or missing. The underlying call
 * leaks — it continues until it naturally completes or the transport
 * times out — but the caller's promise resolves promptly when the
 * signal fires, which is what `PollGuard` needs to reset `inFlight`
 * and unblock the next tick.
 */
export function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(toAbortError(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(toAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(
    typeof reason === "string" && reason.length > 0 ? reason : "aborted",
  );
}
