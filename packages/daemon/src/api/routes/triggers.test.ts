import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { createTriggerRoutes } from "./triggers.js";
import type { ApiDependencies } from "../server.js";
import type { AgentConfig } from "../../config.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function buildApp(db: Database.Database) {
  const config = {
    timezone: "Asia/Tokyo",
  } as unknown as AgentConfig;
  const deps = {
    db,
    config,
  } as unknown as ApiDependencies;
  return createTriggerRoutes(deps);
}

const VALID_PROMPT = "x".repeat(40); // exceeds the 20-char minimum

describe("GET /triggers/catalog", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns the catalog for a known domain", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers/catalog?domain=git");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      domain: string;
      events: Array<{ type: string; needsTime: boolean }>;
    };
    expect(body.domain).toBe("git");
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.needsTime)).toBe(true);
  });

  it("400s on missing domain", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers/catalog");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; knownDomains: string[] };
    expect(body.error).toBe("invalid_domain");
    expect(body.knownDomains).toContain("git");
  });

  it("400s on unknown domain", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers/catalog?domain=nope");
    expect(res.status).toBe(400);
  });
});

describe("GET /triggers", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns an empty list when no triggers exist", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("filters by domain when provided", async () => {
    const app = buildApp(db);
    // Seed by going through the create endpoint
    await app.request("/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "git",
        eventType: "cron.daily",
        prompt: VALID_PROMPT,
        time: "09:00",
      }),
    });
    const ok = await app.request("/triggers?domain=git");
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { items: unknown[] };
    expect(okBody.items).toHaveLength(1);

    const bad = await app.request("/triggers?domain=bogus");
    expect(bad.status).toBe(400);
  });
});

describe("POST /triggers", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it("creates a daily trigger and returns 201", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "git",
        eventType: "cron.daily",
        prompt: VALID_PROMPT,
        time: "09:00",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      item: { id: number; domain: string; eventType: string };
    };
    expect(body.status).toBe("created");
    expect(body.item.domain).toBe("git");
    expect(body.item.eventType).toBe("cron.daily");
    expect(body.item.id).toBeGreaterThan(0);
  });

  it("creates a weekly trigger with daysOfWeek", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "git",
        eventType: "cron.weekly",
        prompt: VALID_PROMPT,
        time: "09:00",
        daysOfWeek: [1, 3, 5],
      }),
    });
    expect(res.status).toBe(201);
  });

  it("400s when validation fails (prompt too short)", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "git",
        eventType: "cron.daily",
        prompt: "short",
        time: "09:00",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("400s when domain is unknown", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "bogus",
        eventType: "cron.daily",
        prompt: VALID_PROMPT,
        time: "09:00",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns the readJsonBody early-error response when the body is not valid JSON", async () => {
    // Exercises the `if (!parsedBody.ok) return parsedBody.response;` early-
    // return at the top of POST /triggers. readJsonBody emits 400 with the
    // canonical envelope when the payload is unparseable.
    const app = buildApp(db);
    const res = await app.request("/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  it("400s when weekly trigger omits daysOfWeek", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "git",
        eventType: "cron.weekly",
        prompt: VALID_PROMPT,
        time: "09:00",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /triggers/:id", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns the trigger by id", async () => {
    const app = buildApp(db);
    const created = await app.request("/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "git",
        eventType: "cron.daily",
        prompt: VALID_PROMPT,
        time: "09:00",
      }),
    });
    const { item } = (await created.json()) as { item: { id: number } };

    const res = await app.request(`/triggers/${item.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number };
    expect(body.id).toBe(item.id);
  });

  it("404s for an unknown id", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers/9999");
    expect(res.status).toBe(404);
  });

  it("400s for non-numeric ids", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers/abc");
    expect(res.status).toBe(400);
  });

  it("400s for non-positive ids", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers/0");
    expect(res.status).toBe(400);
  });
});

describe("PATCH /triggers/:id", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  async function createOne(app: ReturnType<typeof buildApp>): Promise<number> {
    const res = await app.request("/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "git",
        eventType: "cron.daily",
        prompt: VALID_PROMPT,
        time: "09:00",
      }),
    });
    const body = (await res.json()) as { item: { id: number } };
    return body.item.id;
  }

  it("updates an existing trigger", async () => {
    const app = buildApp(db);
    const id = await createOne(app);

    const res = await app.request(`/triggers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; item: { enabled: boolean } };
    expect(body.status).toBe("updated");
    expect(body.item.enabled).toBe(false);
  });

  it("400s when no fields are provided", async () => {
    const app = buildApp(db);
    const id = await createOne(app);
    const res = await app.request(`/triggers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("404s when the id is unknown", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers/9999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  it("400s on non-numeric id", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers/abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on non-positive id", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers/0", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(400);
  });

  it("returns the readJsonBody early-error response when the body is not valid JSON", async () => {
    // Exercises the `if (!parsedBody.ok) return parsedBody.response;` early-
    // return inside PATCH /triggers/:id. id validation passes first (positive
    // integer), then readJsonBody fails with 400.
    const app = buildApp(db);
    const res = await app.request("/triggers/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "@not-json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });
});

describe("DELETE /triggers/:id", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it("deletes an existing trigger", async () => {
    const app = buildApp(db);
    const created = await app.request("/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "git",
        eventType: "cron.daily",
        prompt: VALID_PROMPT,
        time: "09:00",
      }),
    });
    const { item } = (await created.json()) as { item: { id: number } };

    const res = await app.request(`/triggers/${item.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const after = await app.request(`/triggers/${item.id}`);
    expect(after.status).toBe(404);
  });

  it("404s when the id is unknown", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers/9999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("400s on non-numeric id", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers/abc", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("400s on non-positive id", async () => {
    const app = buildApp(db);
    const res = await app.request("/triggers/-1", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});
