import { Hono } from "hono";
import { triggerCreateSchema, triggerUpdateSchema } from "@aitne/shared";
import {
  createTrigger,
  listTriggers,
  getTrigger,
  updateTrigger,
  deleteTrigger,
  getCatalog,
  type TriggerDomain,
} from "../../db/automation-triggers.js";
import { createLogger } from "../../logging.js";
import type { ApiDependencies } from "../server.js";
import { readJsonBody } from "../json-body.js";

const logger = createLogger("triggers-api");

const KNOWN_DOMAINS: ReadonlySet<TriggerDomain> = new Set(["git"]);

function isKnownDomain(value: string): value is TriggerDomain {
  return KNOWN_DOMAINS.has(value as TriggerDomain);
}

export function createTriggerRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, config } = deps;

  // GET /triggers/catalog?domain=git — Event vocabulary for a domain.
  // Catalog is static today (resolved per-domain in code) but lives behind
  // an endpoint so the frontend never needs a redeploy when we add events.
  app.get("/triggers/catalog", (c) => {
    const domainQ = c.req.query("domain");
    if (!domainQ || !isKnownDomain(domainQ)) {
      return c.json({ error: "invalid_domain", knownDomains: [...KNOWN_DOMAINS] }, 400);
    }
    return c.json(getCatalog(domainQ));
  });

  // GET /triggers — List, optionally filtered by domain
  app.get("/triggers", (c) => {
    const domainQ = c.req.query("domain");
    if (domainQ !== undefined && !isKnownDomain(domainQ)) {
      return c.json({ error: "invalid_domain" }, 400);
    }
    const items = listTriggers(db, { domain: domainQ as TriggerDomain | undefined });
    return c.json({ items });
  });

  // GET /triggers/:id
  app.get("/triggers/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "invalid_id" }, 400);
    }
    const item = getTrigger(db, id);
    if (!item) return c.json({ error: "not_found" }, 404);
    return c.json(item);
  });

  // POST /triggers — Create
  app.post("/triggers", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = triggerCreateSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return c.json({ error: "validation_error", details: parsed.error }, 400);
    }
    const data = parsed.data;
    const created = createTrigger(db, {
      domain: data.domain,
      eventType: data.eventType,
      prompt: data.prompt,
      time: data.time,
      daysOfWeek: data.daysOfWeek,
      configTimezone: config.timezone,
    });
    logger.info(
      { id: created.id, domain: created.domain, eventType: created.eventType },
      "Automation trigger created",
    );
    return c.json({ status: "created", item: created }, 201);
  });

  // PATCH /triggers/:id — Update
  app.patch("/triggers/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "invalid_id" }, 400);
    }
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = triggerUpdateSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return c.json({ error: "validation_error", details: parsed.error }, 400);
    }
    const updated = updateTrigger(db, id, {
      ...parsed.data,
      configTimezone: config.timezone,
    });
    if (!updated) return c.json({ error: "not_found" }, 404);
    logger.info(
      { id, enabled: updated.enabled, fields: Object.keys(parsed.data) },
      "Automation trigger updated",
    );
    return c.json({ status: "updated", item: updated });
  });

  // DELETE /triggers/:id
  app.delete("/triggers/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "invalid_id" }, 400);
    }
    const removed = deleteTrigger(db, id);
    if (!removed) return c.json({ error: "not_found" }, 404);
    logger.info({ id }, "Automation trigger deleted");
    return c.json({ status: "deleted", id });
  });

  return app;
}
