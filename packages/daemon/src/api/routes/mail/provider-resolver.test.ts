import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import type { Context } from "hono";
import { writeIntegrations } from "../../../db/integrations-store.js";
import { ProviderNotImplementedError } from "../../../services/mail/account-registry.js";
import type {
  MailAccount,
  MailProvider,
} from "../../../services/mail/provider.js";
import {
  computeAgentWriteTtlMs,
  createProviderResolver,
  notImplementedResponse,
  providerError,
} from "./provider-resolver.js";
import type { MailRouteDependencies } from "./dependencies.js";

/**
 * Pure unit tests for the provider-resolver helpers that own:
 *   - `computeAgentWriteTtlMs` — TTL floor and 2× scaling (parallel coverage
 *     to mail.test.ts; kept here so the peer test owns the helper's full
 *     contract).
 *   - `notImplementedResponse` — 501 envelope with the legacy
 *     `{ error: "not_implemented", message: ... }` shape preserved.
 *   - `providerError` — error classifier that maps upstream
 *     httpStatus / statusCode / response.status (404 / 501 / 401 / 403) to
 *     route-level responses and falls through to 500 otherwise.
 *
 * Each helper takes a Hono `Context`, so the tests build a one-shot route
 * and inspect the response.
 */

function buildAppFromHandler(handler: (c: Context) => Response) {
  const app = new Hono();
  app.get("/probe", (c) => handler(c));
  return app;
}

/** Stub mail account registry covering the two methods provider-resolver
 *  uses (`getAccount`, `getProvider`). Everything else is dropped — the
 *  resolver doesn't call it. */
function makeRegistry(
  accounts: Record<string, MailAccount | null>,
  providers: Record<string, MailProvider | null | (() => never)>,
) {
  return {
    getAccount: (id: string) =>
      accounts[id] === undefined ? null : accounts[id],
    getProvider: async (id: string) => {
      const p = providers[id];
      if (typeof p === "function") {
        p();
        return null;
      }
      return p ?? null;
    },
  } as unknown as MailRouteDependencies["services"]["mail"];
}

function makeAccount(
  overrides: Partial<MailAccount> & { id: string },
): MailAccount {
  return {
    kind: "icloud",
    email: `${overrides.id}@example.test`,
    authStatus: "healthy",
    idleEnabled: false,
    active: true,
    createdAt: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<MailRouteDependencies> & { db: Database.Database },
): MailRouteDependencies {
  return {
    config: {
      enabledMailProviders: ["gmail", "outlook", "icloud", "yahoo"],
      mailPollIntervalSeconds: 180,
    } as unknown as MailRouteDependencies["config"],
    services: {
      mail: makeRegistry({}, {}),
    } as unknown as MailRouteDependencies["services"],
    ...overrides,
  };
}

describe("computeAgentWriteTtlMs (peer)", () => {
  it("clamps to the 5-minute floor when poll × 2 is below it", () => {
    expect(computeAgentWriteTtlMs(undefined)).toBe(5 * 60 * 1000);
    expect(computeAgentWriteTtlMs(60)).toBe(5 * 60 * 1000);
    expect(computeAgentWriteTtlMs(149)).toBe(5 * 60 * 1000);
  });

  it("scales to 2× poll interval once it exceeds the floor", () => {
    expect(computeAgentWriteTtlMs(180)).toBe(360_000);
    expect(computeAgentWriteTtlMs(600)).toBe(20 * 60 * 1000);
  });
});

describe("notImplementedResponse", () => {
  it("returns 501 with not_implemented envelope and preserves legacy message", async () => {
    const app = buildAppFromHandler((c) =>
      notImplementedResponse(c, "updateDraft", "imap"),
    );
    const res = await app.request("/probe");
    expect(res.status).toBe(501);
    const body = (await res.json()) as any;
    // Legacy shape preserved for existing route tests.
    expect(body.message).toBe("updateDraft not supported on imap");
    // Envelope carries the standard issue list under `errors`.
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors[0].code).toBe("mail.not_implemented");
    expect(body.errors[0].field).toBe("provider.updateDraft");
    expect(body.errors[0].received).toBe("imap");
  });

  it("composes a hint that names the operation and provider kind", async () => {
    const app = buildAppFromHandler((c) =>
      notImplementedResponse(c, "createDraft", "yahoo"),
    );
    const res = await app.request("/probe");
    const body = (await res.json()) as any;
    expect(body.errors[0].hint).toMatch(/createDraft not supported on yahoo/);
  });
});

describe("providerError", () => {
  it("maps upstream httpStatus=404 to a 404 mail.account_not_found", async () => {
    const err = Object.assign(new Error("not there"), { httpStatus: 404 });
    const app = buildAppFromHandler((c) => providerError(c, err, "get-msg"));
    const res = await app.request("/probe");
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.message).toBe("not there");
    expect(body.errors[0].code).toBe("mail.account_not_found");
    expect(body.errors[0].field).toBe("get-msg");
  });

  it("maps statusCode=404 (no httpStatus) to the same 404", async () => {
    const err = Object.assign(new Error("missing"), { statusCode: 404 });
    const app = buildAppFromHandler((c) => providerError(c, err, "list"));
    const res = await app.request("/probe");
    expect(res.status).toBe(404);
  });

  it("maps response.status=404 (axios-like shape) to 404", async () => {
    const err = Object.assign(new Error("axios 404"), {
      response: { status: 404 },
    });
    const app = buildAppFromHandler((c) => providerError(c, err, "list"));
    const res = await app.request("/probe");
    expect(res.status).toBe(404);
  });

  it("maps upstream httpStatus=501 to 501 mail.not_implemented", async () => {
    const err = Object.assign(new Error("imap draft create unsupported"), {
      httpStatus: 501,
    });
    const app = buildAppFromHandler((c) => providerError(c, err, "createDraft"));
    const res = await app.request("/probe");
    expect(res.status).toBe(501);
    const body = (await res.json()) as any;
    expect(body.errors[0].code).toBe("mail.not_implemented");
    expect(body.errors[0].hint).toMatch(/Stop retrying/);
  });

  it("maps upstream 401 to 502 mail.provider_auth_error", async () => {
    const err = Object.assign(new Error("token expired"), { httpStatus: 401 });
    const app = buildAppFromHandler((c) => providerError(c, err, "list"));
    const res = await app.request("/probe");
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.errors[0].code).toBe("mail.provider_auth_error");
    expect(body.message).toBe("token expired");
  });

  it("maps upstream 403 to 502 mail.provider_auth_error", async () => {
    const err = Object.assign(new Error("forbidden"), { httpStatus: 403 });
    const app = buildAppFromHandler((c) => providerError(c, err, "list"));
    const res = await app.request("/probe");
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.errors[0].code).toBe("mail.provider_auth_error");
  });

  it("falls through to 500 mail.upstream_error when no recognised status", async () => {
    const app = buildAppFromHandler((c) =>
      providerError(c, new Error("boom"), "list"),
    );
    const res = await app.request("/probe");
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.errors[0].code).toBe("mail.upstream_error");
    expect(body.errors[0].hint).toMatch(/Mail provider list failed/);
    expect(body.message).toBe("boom");
    // legacyErrorCode is set to the tag so existing tests can find it.
    expect(body.error).toBe("list");
  });

  it("stringifies non-Error throwables in the legacy message field", async () => {
    const app = buildAppFromHandler((c) =>
      providerError(c, "raw-string", "tag"),
    );
    const res = await app.request("/probe");
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.message).toBe("raw-string");
  });

  it("ignores a non-numeric httpStatus and falls through to 500", async () => {
    // pickNumber rejects non-finite / non-number values — the err falls to
    // the default 500 branch instead of being misclassified.
    const err = Object.assign(new Error("weird"), { httpStatus: "404" });
    const app = buildAppFromHandler((c) => providerError(c, err, "list"));
    const res = await app.request("/probe");
    expect(res.status).toBe(500);
  });

  it("ignores non-finite statusCode (NaN) and falls through to 500", async () => {
    const err = Object.assign(new Error("nan"), { statusCode: Number.NaN });
    const app = buildAppFromHandler((c) => providerError(c, err, "list"));
    const res = await app.request("/probe");
    expect(res.status).toBe(500);
  });

  it("prefers httpStatus over statusCode when both are set", async () => {
    // Coverage for the `??` chain in pickNumber's caller: httpStatus wins.
    const err = Object.assign(new Error("x"), {
      httpStatus: 404,
      statusCode: 500,
    });
    const app = buildAppFromHandler((c) => providerError(c, err, "tag"));
    const res = await app.request("/probe");
    expect(res.status).toBe(404);
  });
});

describe("createProviderResolver", () => {
  function makeDb(): Database.Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE integration_writes (
        integration TEXT NOT NULL,
        item_id     TEXT NOT NULL,
        written_at  TEXT NOT NULL,
        written_by  TEXT NOT NULL DEFAULT 'agent',
        expires_at  TEXT NOT NULL,
        PRIMARY KEY (integration, item_id)
      );
    `);
    return db;
  }

  describe("resolveProvider", () => {
    it("returns 503 mail_not_configured when the registry is null", async () => {
      const db = makeDb();
      const deps = makeDeps({
        db,
        services: { mail: null } as unknown as MailRouteDependencies["services"],
      });
      const r = createProviderResolver(deps);
      const out = await r.resolveProvider("a");
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(503);
        expect(out.code).toBe("mail_not_configured");
      }
    });

    it("returns 404 not_found when the account does not exist", async () => {
      const db = makeDb();
      const deps = makeDeps({
        db,
        services: {
          mail: makeRegistry({}, {}),
        } as unknown as MailRouteDependencies["services"],
      });
      const r = createProviderResolver(deps);
      const out = await r.resolveProvider("missing");
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(404);
        expect(out.code).toBe("not_found");
      }
    });

    it("returns 410 integration_delegated for a gated Gmail account in delegated mode", async () => {
      const db = makeDb();
      writeIntegrations(db, {
        gmail: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: [],
          lastChangedAt: "2026-05-01T00:00:00Z",
        },
      });
      const account = makeAccount({ id: "a1", kind: "gmail" });
      const deps = makeDeps({
        db,
        services: {
          mail: makeRegistry({ a1: account }, {}),
        } as unknown as MailRouteDependencies["services"],
      });
      const r = createProviderResolver(deps);
      const out = await r.resolveProvider("a1");
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(410);
        expect(out.code).toBe("integration_delegated");
        expect(out.integration).toBe("gmail");
        expect(out.mode).toBe("delegated");
        expect(out.backend).toBe("claude");
      }
    });

    it("returns 410 integration_native for a gated Outlook account in native mode", async () => {
      const db = makeDb();
      writeIntegrations(db, {
        outlook_mail: {
          mode: "native",
          nativeBackend: "claude",
          deniedTools: [],
          lastChangedAt: "2026-05-01T00:00:00Z",
        },
      });
      const account = makeAccount({ id: "a1", kind: "outlook" });
      const deps = makeDeps({
        db,
        services: {
          mail: makeRegistry({ a1: account }, {}),
        } as unknown as MailRouteDependencies["services"],
      });
      const r = createProviderResolver(deps);
      const out = await r.resolveProvider("a1");
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(410);
        expect(out.code).toBe("integration_native");
        expect(out.mode).toBe("native");
      }
    });

    it("returns 400 provider_not_enabled (kind_not_enabled) when the kind isn't in enabledMailProviders", async () => {
      const db = makeDb();
      const account = makeAccount({ id: "a1", kind: "yahoo" });
      const deps = makeDeps({
        db,
        config: {
          enabledMailProviders: ["gmail"],
          mailPollIntervalSeconds: 180,
        } as unknown as MailRouteDependencies["config"],
        services: {
          mail: makeRegistry({ a1: account }, {}),
        } as unknown as MailRouteDependencies["services"],
      });
      const r = createProviderResolver(deps);
      const out = await r.resolveProvider("a1");
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(400);
        expect(out.code).toBe("provider_not_enabled");
        expect(out.detail).toBe("kind_not_enabled");
      }
    });

    it("returns 400 account_inactive when the account exists but is disabled", async () => {
      const db = makeDb();
      const account = makeAccount({ id: "a1", kind: "icloud", active: false });
      const deps = makeDeps({
        db,
        services: {
          mail: makeRegistry({ a1: account }, {}),
        } as unknown as MailRouteDependencies["services"],
      });
      const r = createProviderResolver(deps);
      const out = await r.resolveProvider("a1");
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(400);
        expect(out.detail).toBe("account_inactive");
      }
    });

    it("returns 400 account_unhealthy when auth requires re-consent", async () => {
      const db = makeDb();
      const account = makeAccount({
        id: "a1",
        kind: "icloud",
        authStatus: "requires_consent",
      });
      const deps = makeDeps({
        db,
        services: {
          mail: makeRegistry({ a1: account }, {}),
        } as unknown as MailRouteDependencies["services"],
      });
      const r = createProviderResolver(deps);
      const out = await r.resolveProvider("a1");
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(400);
        expect(out.detail).toBe("account_unhealthy");
      }
    });

    it("returns 501 provider_not_implemented when registry.getProvider returns null", async () => {
      const db = makeDb();
      const account = makeAccount({ id: "a1", kind: "icloud" });
      const deps = makeDeps({
        db,
        services: {
          mail: makeRegistry({ a1: account }, { a1: null }),
        } as unknown as MailRouteDependencies["services"],
      });
      const r = createProviderResolver(deps);
      const out = await r.resolveProvider("a1");
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(501);
        expect(out.code).toBe("provider_not_implemented");
      }
    });

    it("translates ProviderNotImplementedError into a 501 with the error's code", async () => {
      const db = makeDb();
      const account = makeAccount({ id: "a1", kind: "icloud" });
      const deps = makeDeps({
        db,
        services: {
          mail: makeRegistry(
            { a1: account },
            {
              a1: () => {
                throw new ProviderNotImplementedError("icloud");
              },
            },
          ),
        } as unknown as MailRouteDependencies["services"],
      });
      const r = createProviderResolver(deps);
      const out = await r.resolveProvider("a1");
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(501);
        expect(out.code).toBe("provider_not_implemented");
      }
    });

    it("rethrows non-ProviderNotImplementedError errors from getProvider", async () => {
      const db = makeDb();
      const account = makeAccount({ id: "a1", kind: "icloud" });
      const deps = makeDeps({
        db,
        services: {
          mail: makeRegistry(
            { a1: account },
            {
              a1: () => {
                throw new Error("unexpected");
              },
            },
          ),
        } as unknown as MailRouteDependencies["services"],
      });
      const r = createProviderResolver(deps);
      await expect(r.resolveProvider("a1")).rejects.toThrow("unexpected");
    });

    it("returns ok with the provider on the happy path", async () => {
      const db = makeDb();
      const account = makeAccount({ id: "a1", kind: "icloud" });
      const provider = { kind: "icloud" } as unknown as MailProvider;
      const deps = makeDeps({
        db,
        services: {
          mail: makeRegistry({ a1: account }, { a1: provider }),
        } as unknown as MailRouteDependencies["services"],
      });
      const r = createProviderResolver(deps);
      const out = await r.resolveProvider("a1");
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.provider).toBe(provider);
    });
  });

  describe("renderResolveError", () => {
    it("emits the 410 body shape with integration / backend / mode", async () => {
      const db = makeDb();
      const r = createProviderResolver(makeDeps({ db }));
      const app = new Hono();
      app.get("/x", (c) =>
        r.renderResolveError(c, {
          ok: false,
          status: 410,
          code: "integration_delegated",
          message: "gated",
          integration: "gmail",
          backend: "claude",
          mode: "delegated",
        }),
      );
      const res = await app.request("/x");
      expect(res.status).toBe(410);
      const body = (await res.json()) as any;
      expect(body).toEqual({
        error: "integration_delegated",
        message: "gated",
        integration: "gmail",
        backend: "claude",
        mode: "delegated",
      });
    });

    it("defaults mode='delegated' when the 410 outcome predates native widening", async () => {
      const db = makeDb();
      const r = createProviderResolver(makeDeps({ db }));
      const app = new Hono();
      app.get("/x", (c) =>
        r.renderResolveError(c, {
          ok: false,
          status: 410,
          code: "integration_delegated",
          message: "m",
        }),
      );
      const res = await app.request("/x");
      const body = (await res.json()) as any;
      expect(body.mode).toBe("delegated");
      expect(body.integration).toBeNull();
      expect(body.backend).toBeNull();
    });

    it("emits the generic body with detail for non-410 outcomes", async () => {
      const db = makeDb();
      const r = createProviderResolver(makeDeps({ db }));
      const app = new Hono();
      app.get("/x", (c) =>
        r.renderResolveError(c, {
          ok: false,
          status: 400,
          code: "provider_not_enabled",
          message: "scope-gated",
          detail: "kind_not_enabled",
        }),
      );
      const res = await app.request("/x");
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body).toEqual({
        error: "provider_not_enabled",
        message: "scope-gated",
        detail: "kind_not_enabled",
      });
    });
  });

  describe("ensureMethod", () => {
    it("returns true when the provider implements the named method", () => {
      const db = makeDb();
      const r = createProviderResolver(makeDeps({ db }));
      const provider = { send: () => undefined } as unknown as MailProvider;
      expect(r.ensureMethod(provider, "send")).toBe(true);
    });

    it("returns false when the provider does not implement the named method", () => {
      const db = makeDb();
      const r = createProviderResolver(makeDeps({ db }));
      expect(r.ensureMethod({} as MailProvider, "send")).toBe(false);
    });
  });

  describe("agent-write attribution helpers", () => {
    function makeTracker() {
      const calls: Array<{ key: string; opts: unknown }> = [];
      const tracker = {
        markWriting: (key: string, _signal: unknown, opts: unknown) => {
          calls.push({ key, opts });
        },
      } as unknown as MailRouteDependencies["writeTracker"];
      return { tracker, calls };
    }

    it("markAgentWrite stamps the mail:<acct>:<providerMsgId> key with the derived TTL", () => {
      const db = makeDb();
      const { tracker, calls } = makeTracker();
      const r = createProviderResolver(
        makeDeps({ db, writeTracker: tracker }),
      );
      r.markAgentWrite("acct-1", "msg-9");
      expect(calls).toHaveLength(1);
      expect(calls[0].key).toBe("mail:acct-1:msg-9");
      // pollInterval=180s × 2 = 360_000ms (above the 5min floor)
      expect((calls[0].opts as { ttlMs: number }).ttlMs).toBe(360_000);
    });

    it("markAgentWrite is a no-op when no writeTracker is wired", () => {
      const db = makeDb();
      // No tracker — deps.writeTracker is undefined; the ?. must short-circuit.
      const r = createProviderResolver(makeDeps({ db }));
      expect(() => r.markAgentWrite("a", "b")).not.toThrow();
    });

    it("markAgentWriteRfc822 stamps the mail:<acct>:rfc822:<id> key when id is set", () => {
      const db = makeDb();
      const { tracker, calls } = makeTracker();
      const r = createProviderResolver(
        makeDeps({ db, writeTracker: tracker }),
      );
      r.markAgentWriteRfc822("acct-1", "<rfc-id@host>");
      expect(calls).toHaveLength(1);
      expect(calls[0].key).toBe("mail:acct-1:rfc822:<rfc-id@host>");
    });

    it("markAgentWriteRfc822 is a no-op when id is null/undefined/empty", () => {
      const db = makeDb();
      const { tracker, calls } = makeTracker();
      const r = createProviderResolver(
        makeDeps({ db, writeTracker: tracker }),
      );
      r.markAgentWriteRfc822("acct-1", null);
      r.markAgentWriteRfc822("acct-1", undefined);
      r.markAgentWriteRfc822("acct-1", "");
      expect(calls).toEqual([]);
    });

    it("markGmailIntegrationWrite skips non-Gmail accounts", () => {
      const db = makeDb();
      const account = makeAccount({ id: "a1", kind: "icloud" });
      const r = createProviderResolver(
        makeDeps({
          db,
          services: {
            mail: makeRegistry({ a1: account }, {}),
          } as unknown as MailRouteDependencies["services"],
        }),
      );
      r.markGmailIntegrationWrite("a1", "id-1", "id-2");
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM integration_writes")
        .get() as { n: number };
      expect(rows.n).toBe(0);
    });

    it("markGmailIntegrationWrite stamps integration_writes for Gmail accounts", () => {
      const db = makeDb();
      const account = makeAccount({ id: "a1", kind: "gmail" });
      const r = createProviderResolver(
        makeDeps({
          db,
          services: {
            mail: makeRegistry({ a1: account }, {}),
          } as unknown as MailRouteDependencies["services"],
        }),
      );
      r.markGmailIntegrationWrite("a1", "id-1", null, undefined, "", "id-2");
      const rows = db
        .prepare(
          "SELECT item_id FROM integration_writes WHERE integration = 'gmail' ORDER BY item_id ASC",
        )
        .all() as Array<{ item_id: string }>;
      expect(rows.map((r) => r.item_id)).toEqual(["id-1", "id-2"]);
    });
  });
});
