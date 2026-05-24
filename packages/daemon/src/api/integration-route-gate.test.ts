import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { writeIntegrations } from "../db/integrations-store.js";
import {
  createIntegrationRouteGate,
  resolveIntegrationForPath,
} from "./integration-route-gate.js";
import {
  INTEGRATION_DESCRIPTORS,
  type IntegrationDescriptor,
  type IntegrationKey,
} from "@aitne/shared";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("resolveIntegrationForPath", () => {
  const descriptors = Object.values(
    INTEGRATION_DESCRIPTORS,
  ) as readonly IntegrationDescriptor[];

  function index() {
    const out: Array<{ prefix: string; key: IntegrationKey }> = [];
    for (const d of descriptors) {
      for (const p of d.apiRoutesTouched) {
        out.push({ prefix: p, key: d.key });
      }
    }
    return out.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  it("matches an exact prefix (notion/query)", () => {
    expect(resolveIntegrationForPath("/api/notion/query", index())).toBe(
      "notion",
    );
  });

  it("matches a deeper sub-path", () => {
    expect(resolveIntegrationForPath("/api/notion/pages/abc/content", index())).toBe(
      "notion",
    );
  });

  it("matches `/api/calendar` paths — DELEGATED-MODE-V2 §3.4 restored apiRoutesTouched for google_calendar", () => {
    expect(resolveIntegrationForPath("/api/calendar", index())).toBe(
      "google_calendar",
    );
    expect(resolveIntegrationForPath("/api/calendar/events", index())).toBe(
      "google_calendar",
    );
  });

  it("does not match a same-prefix-different-name path (notion/query → notion-other)", () => {
    expect(resolveIntegrationForPath("/api/notion-other", index())).toBe(null);
  });

  it("returns null for a path no integration touches", () => {
    expect(resolveIntegrationForPath("/api/health", index())).toBe(null);
  });

  it("matches notion sub-prefixes without gating /api/notion/databases", () => {
    // Per NOTION_DELEGATION_DESIGN.md §5 / §7.2: query, search, and pages
    // hit the API and are gated; databases is a config dump, ungated.
    expect(resolveIntegrationForPath("/api/notion/query", index())).toBe(
      "notion",
    );
    expect(resolveIntegrationForPath("/api/notion/search", index())).toBe(
      "notion",
    );
    expect(resolveIntegrationForPath("/api/notion/pages", index())).toBe(
      "notion",
    );
    expect(
      resolveIntegrationForPath("/api/notion/pages/abc123", index()),
    ).toBe("notion");
    expect(
      resolveIntegrationForPath("/api/notion/pages/abc123/content", index()),
    ).toBe("notion");
    expect(resolveIntegrationForPath("/api/notion/databases", index())).toBe(
      null,
    );
    expect(
      resolveIntegrationForPath("/api/notion/databases/foo", index()),
    ).toBe(null);
  });

  it("does not match `/api/mail` paths because gmail.apiRoutesTouched is empty", () => {
    // The mail multi-provider invariant is enforced by the registry, not
    // the matcher. This test pins the invariant from the matcher's side
    // so a future regression to add `/api/mail` here is caught by tests
    // in TWO places (here and integrations.test.ts).
    expect(resolveIntegrationForPath("/api/mail/accounts", index())).toBe(null);
    expect(
      resolveIntegrationForPath("/api/mail/123/messages", index()),
    ).toBe(null);
  });
});

describe("createIntegrationRouteGate middleware", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  function buildApp() {
    const app = new Hono();
    app.use("*", createIntegrationRouteGate({ db }));
    app.get("/api/calendar/events", (c) => c.json({ ok: true }));
    app.get("/api/calendar", (c) => c.json({ ok: true, root: true }));
    app.get("/api/health", (c) => c.json({ alive: true }));
    app.get("/api/mail/accounts", (c) => c.json({ accounts: [] }));
    app.get("/api/notion/databases", (c) => c.json({ databases: {} }));
    app.get("/api/notion/query", (c) => c.json({ ok: true }));
    app.get("/api/notion/search", (c) => c.json({ ok: true }));
    app.get("/api/notion/pages/:id", (c) => c.json({ ok: true }));
    return app;
  }

  it("passes the request through when the integration is direct", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const res = await buildApp().request("/api/calendar/events");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("410-gates `/api/calendar/events` when the integration is disabled", async () => {
    // INTEGRATION_NATIVE_MODE_DESIGN.md §3.1 / §9.1 — `disabled` 410s every
    // route in `apiRoutesTouched` so prompts that retained a stale daemon
    // reference cannot leak through. The previous behaviour ("pass through;
    // the route handler returns its own service-not-configured error") was
    // ambiguous: the gate could not distinguish "user explicitly disabled"
    // from "user has not set up yet" (the §16 unconfigured-vs-disabled open
    // question). The 410 collapses both into the documented gate verdict.
    const res = await buildApp().request("/api/calendar/events");
    expect(res.status).toBe(410);
    expect(res.headers.get("X-Integration-Mode")).toBe("disabled");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "integration_disabled",
      integration: "google_calendar",
      mode: "disabled",
    });
  });

  it("passes the request through when a registry-touched route is in direct mode (notion direct)", async () => {
    writeIntegrations(db, {
      notion: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const res = await buildApp().request("/api/notion/query");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("410-gates `/api/calendar/events` when google_calendar is delegated — DELEGATED-MODE-V2 §6.3 defense-in-depth", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const res = await buildApp().request("/api/calendar/events");
    expect(res.status).toBe(410);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "integration_delegated",
      integration: "google_calendar",
      backend: "claude",
      mode: "delegated",
    });
  });

  it("410-gates the `/api/calendar` prefix root too", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const res = await buildApp().request("/api/calendar");
    expect(res.status).toBe(410);
  });

  it("does not gate paths the registry leaves untouched", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const res = await buildApp().request("/api/health");
    expect(res.status).toBe(200);
  });

  it("returns 410 for /api/notion/{query,search,pages/:id} when notion is delegated", async () => {
    writeIntegrations(db, {
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    const app = buildApp();
    for (const path of [
      "/api/notion/query",
      "/api/notion/search",
      "/api/notion/pages/abc",
    ]) {
      const res = await app.request(path);
      expect(res.status, `expected 410 for ${path}`).toBe(410);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        error: "integration_delegated",
        integration: "notion",
        backend: "claude",
        mode: "delegated",
      });
    }
  });

  it("does not gate /api/notion/databases when notion is delegated", async () => {
    writeIntegrations(db, {
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    const res = await buildApp().request("/api/notion/databases");
    expect(res.status).toBe(200);
  });

  it("does not gate /api/mail when gmail is delegated — multi-provider routes handle per-account", async () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const res = await buildApp().request("/api/mail/accounts");
    expect(res.status).toBe(200);
  });

  it("no-ops when no descriptors have apiRoutesTouched entries", async () => {
    const app = new Hono();
    app.use(
      "*",
      createIntegrationRouteGate({
        db,
        descriptors: [],
      }),
    );
    app.get("/anything", (c) => c.json({ ok: true }));
    const res = await app.request("/anything");
    expect(res.status).toBe(200);
  });

  it("410 message names the delegated backend AND the cross-backend exec endpoint", async () => {
    // The route gate doesn't know the calling agent's session backend, so
    // it cannot tell whether "use your backend's tool" is correct (only
    // true under same-backend delegation). Point at both paths so the
    // agent can pick. The cross-backend chokepoint is `/exec`.
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "gemini",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    });
    const res = await buildApp().request("/api/calendar/events");
    expect(res.status).toBe(410);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.message).toBe("string");
    const message = body.message as string;
    expect(message).toContain("delegated to gemini");
    expect(message).toContain("/api/integrations/google_calendar/exec");
    // Must NOT prescribe "your backend's tool" unconditionally — that's
    // wrong when the caller is on a different backend than the connector.
    expect(message).not.toMatch(/use your backend's [\w ]*tool/i);
  });

  it("410 message for a user-managed connector points the agent at the user-installed MCP, not the daemon /exec fallback", async () => {
    // Pins the `descriptor.userManagedConnector` branch in the gate
    // message builder. outlook_calendar is single-provider with
    // `apiRoutesTouched: ["/api/calendar/outlook"]` and `userManagedConnector: true` —
    // there is no daemon-side `/api/integrations/outlook_calendar/exec`
    // proxy, so the message must NOT suggest one. Instead it should
    // direct the agent at the
    // user-installed MCP/connector on the delegated backend.
    writeIntegrations(db, {
      outlook_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-01T00:00:00Z",
      },
    });
    const app = new Hono();
    app.use("*", createIntegrationRouteGate({ db }));
    app.get("/api/calendar/outlook/events", (c) => c.json({ ok: true }));
    const res = await app.request("/api/calendar/outlook/events");
    expect(res.status).toBe(410);
    const body = (await res.json()) as Record<string, unknown>;
    const message = body.message as string;
    expect(message).toContain("delegated to claude");
    expect(message).toContain("MCP");
    // Must NOT mention the cross-backend exec fallback, since the
    // daemon does not proxy this integration.
    expect(message).not.toContain("/api/integrations/outlook_calendar/exec");
  });

  it("410 native message for a user-managed connector points at the user-installed MCP, NOT at a daemon-shipped SKILL.native variant", async () => {
    // INTEGRATION_NATIVE_MODE_DESIGN.md §5.3 (2026-05 amendment). The
    // native gate's user-managed branch mirrors the delegated branch
    // above: outlook_calendar native must point the agent at the user's
    // own Outlook MCP and must NOT cite a `SKILL.native.<backend>.md`
    // body (the daemon does not ship one for user-managed integrations).
    writeIntegrations(db, {
      outlook_calendar: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    const app = new Hono();
    app.use("*", createIntegrationRouteGate({ db }));
    app.get("/api/calendar/outlook/events", (c) => c.json({ ok: true }));
    const res = await app.request("/api/calendar/outlook/events");
    expect(res.status).toBe(410);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("integration_native");
    const message = body.message as string;
    expect(message).toContain("native mode");
    expect(message).toContain("bound to claude");
    // User-managed copy directs the agent at the user-installed MCP.
    expect(message).toContain("Outlook Calendar MCP / connector");
    expect(message).toMatch(/user has registered/i);
    // Must NOT reference a SKILL.native variant — that's the
    // descriptor-driven branch which doesn't apply here.
    expect(message).not.toContain("SKILL.native");
  });

  it("410 native message for a descriptor-driven connector cites the SKILL.native.<backend>.md body", async () => {
    // Symmetric to the user-managed assertion above. google_calendar
    // ships a `backendConnectors` entry for claude, so the native gate
    // points the agent at the daemon-shipped variant body, not the
    // user-installed-MCP language.
    writeIntegrations(db, {
      google_calendar: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    const app = new Hono();
    app.use("*", createIntegrationRouteGate({ db }));
    app.get("/api/calendar/events", (c) => c.json({ ok: true }));
    const res = await app.request("/api/calendar/events");
    expect(res.status).toBe(410);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("integration_native");
    const message = body.message as string;
    expect(message).toContain("native mode");
    expect(message).toContain("SKILL.native.claude.md");
    expect(message).not.toContain("user-installed");
  });

  it("410 message for Notion routes points the agent at /api/integrations/notion/exec", async () => {
    // Mode-filter extension acceptance (§9): the integration-agnostic 410
    // message that names the cross-backend exec endpoint must hold for
    // every gated integration, not just Calendar. Notion is the second
    // registry-gated surface and shares the same message template.
    writeIntegrations(db, {
      notion: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-26T00:00:00Z",
      },
    });
    const res = await buildApp().request("/api/notion/query");
    expect(res.status).toBe(410);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.message).toBe("string");
    const message = body.message as string;
    expect(message).toContain("delegated to codex");
    expect(message).toContain("/api/integrations/notion/exec");
    expect(message).not.toMatch(/use your backend's [\w ]*tool/i);
  });

  // ── INTEGRATION_NATIVE_MODE_DESIGN.md Phase B1 ──────────────────────────

  it("410-gates native mode with `X-Integration-Mode: native` header (§9.1)", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    const res = await buildApp().request("/api/calendar/events");
    expect(res.status).toBe(410);
    expect(res.headers.get("X-Integration-Mode")).toBe("native");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "integration_native",
      integration: "google_calendar",
      backend: "claude",
      mode: "native",
    });
    expect(typeof body.message).toBe("string");
    // Must point the agent at the connector's native MCP, not at /exec.
    expect((body.message as string)).toContain("native MCP");
    expect((body.message as string)).not.toContain("/api/integrations/google_calendar/exec");
  });

  it("410-gates disabled mode with `X-Integration-Mode: disabled` header (§9.1)", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "disabled",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    const res = await buildApp().request("/api/calendar/events");
    expect(res.status).toBe(410);
    expect(res.headers.get("X-Integration-Mode")).toBe("disabled");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "integration_disabled",
      integration: "google_calendar",
      mode: "disabled",
    });
  });
});
