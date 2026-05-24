import type { Context } from "hono";
import { createLogger } from "../logging.js";

const logger = createLogger("api-json-body");

/**
 * Default body size cap when a caller does not pass an explicit `maxBytes`.
 *
 * 1 MiB is wide enough for every realistic JSON config / command body in
 * this codebase (the largest opt-in caps explicitly set elsewhere are 32–64
 * KiB; the agent run-now payload tops out at a few KiB) while still
 * neutralising a malicious-prompt-injection scenario where the agent gets
 * coaxed into POSTing megabytes to a daemon endpoint and pinning RAM.
 *
 * Callers that legitimately accept larger payloads (attachments, file
 * uploads) must opt out by passing `maxBytes: null`. There are no such
 * callers today; if one lands later, the explicit opt-out is the audit
 * point.
 */
export const DEFAULT_JSON_BODY_MAX_BYTES = 1_048_576;

/**
 * Read a JSON body off a Hono request. On parse failure, return a 400
 * `invalid_json_body` response carrying the parser's error message and
 * log one warning line.
 *
 * Surfacing the parse error (rather than letting Hono's default 500
 * handler swallow it) is how agents learn their body shape is wrong
 * and self-correct. A bad body delivered as a 500 has been misdiagnosed
 * as an unrelated subprocess permission failure, costing several retry
 * cycles per session before the agent recovers.
 *
 * The body is rejected with a 413 `body_too_large` response if the
 * declared `Content-Length` or the actual decoded byte count exceeds
 * the cap. The cap defaults to `DEFAULT_JSON_BODY_MAX_BYTES` (1 MiB);
 * routes that need a tighter ceiling pass it explicitly, and routes
 * that genuinely accept unbounded payloads pass `maxBytes: null` to
 * opt out.
 */
export async function readJsonBody(
  c: Context,
  options?: { maxBytes?: number | null },
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const explicit = options?.maxBytes;
  const maxBytes: number | null =
    explicit === undefined ? DEFAULT_JSON_BODY_MAX_BYTES : explicit;

  if (maxBytes !== null) {
    const declared = c.req.header("content-length");
    if (declared !== undefined) {
      const declaredN = Number.parseInt(declared, 10);
      if (Number.isFinite(declaredN) && declaredN > maxBytes) {
        logger.warn(
          {
            path: c.req.path,
            method: c.req.method,
            contentLength: declaredN,
            maxBytes,
          },
          "Request rejected — Content-Length exceeds size limit",
        );
        return {
          ok: false,
          response: c.json(
            { error: "body_too_large", maxBytes, actualBytes: declaredN },
            413,
          ),
        };
      }
    }

    let raw: string;
    try {
      raw = await c.req.text();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn(
        { path: c.req.path, method: c.req.method, detail },
        "Request rejected — body could not be read",
      );
      return {
        ok: false,
        response: c.json({ error: "invalid_json_body", message: detail }, 400),
      };
    }

    // Defense-in-depth: a missing or lying Content-Length still gets
    // caught by the post-read byte count. Buffer.byteLength reports the
    // UTF-8 byte length so multi-byte content is measured correctly.
    const actualBytes = Buffer.byteLength(raw, "utf-8");
    if (actualBytes > maxBytes) {
      logger.warn(
        { path: c.req.path, method: c.req.method, actualBytes, maxBytes },
        "Request rejected — body exceeds size limit",
      );
      return {
        ok: false,
        response: c.json(
          { error: "body_too_large", maxBytes, actualBytes },
          413,
        ),
      };
    }

    try {
      return { ok: true, body: JSON.parse(raw) as unknown };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn(
        { path: c.req.path, method: c.req.method, detail },
        "Request rejected — body is not valid JSON",
      );
      return {
        ok: false,
        response: c.json({ error: "invalid_json_body", message: detail }, 400),
      };
    }
  }

  // Explicit opt-out path: no cap. Reserved for routes that legitimately
  // accept large payloads (e.g. attachment uploads). New callers should
  // prefer an explicit byte cap.
  try {
    return { ok: true, body: await c.req.json() };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(
      { path: c.req.path, method: c.req.method, detail },
      "Request rejected — body is not valid JSON",
    );
    return {
      ok: false,
      response: c.json({ error: "invalid_json_body", message: detail }, 400),
    };
  }
}
