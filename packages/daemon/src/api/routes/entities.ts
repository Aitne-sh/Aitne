import { Hono } from "hono";
import type Database from "better-sqlite3";
import { isDomain, isEntityType } from "@aitne/shared";
import {
  findEntitiesByDomainTypeDate,
  findEntitiesBySource,
  findEntitiesBySourceKey,
  getEntityByPath,
  type EntityRecord,
} from "../../db/entities-store.js";
import type { ApiDependencies } from "../server.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

/**
 * Entity-mirror lookup contract (docs/design/21-management-registry-and-
 * entities.md §7.6).
 *
 * GET /api/entities                   ← search
 *   query params (mutually exclusive shapes):
 *     • source=<app>&external_id=<eid>      → tier-1 exact match
 *     • source=<app>[&limit=N]              → list-by-source bias
 *                                            (managed-tasks skill `## Register`
 *                                            Step 4a — pick the (domain,
 *                                            type) already dominant for app)
 *     • domain=<d>&type=<t>&date=<YYYY-MM-DD>[&q=<title>]
 *                                            → tier-2 fuzzy match
 *
 * GET /api/entities/by-path?path=<...> ← exact path
 *
 * The mirror is NOT authoritative (§7.6); responses include the parsed
 * frontmatter.sources so the agent's session can fall through to the
 * MD file when the mirror's data is too thin. The response shape is
 * stable across the two query forms — both return an `items` array
 * plus `tier`/`q` debug hints so the skill can log which lookup tier
 * answered.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface EntityResponseItem {
  path: string;
  domain: string;
  type: string;
  slug: string;
  title: string;
  status: string | null;
  date: string | null;
  lastSyncedAt: string | null;
  sources: Record<string, unknown>;
}

function toResponse(record: EntityRecord): EntityResponseItem {
  return {
    path: record.path,
    domain: record.domain,
    type: record.type,
    slug: record.slug,
    title: record.title,
    status: record.status,
    date: record.date,
    lastSyncedAt: record.lastSyncedAt,
    sources: record.sources,
  };
}

export interface EntitiesRoutesDeps {
  db: Database.Database;
}

export function createEntitiesRoutes(deps: EntitiesRoutesDeps): Hono {
  const app = new Hono();
  const { db } = deps;

  // GET /entities — search by either (source, external_id) or
  // (domain, type, date[, q]). Query-shape mismatch returns 400 so a
  // malformed agent call does not silently fall through to the wrong
  // tier.
  app.get("/entities", (c) => {
    const source = c.req.query("source");
    const externalId = c.req.query("external_id");
    const domain = c.req.query("domain");
    const type = c.req.query("type");
    const date = c.req.query("date");
    const q = c.req.query("q") ?? undefined;
    const limitRaw = c.req.query("limit");

    const hasTier1 = source !== undefined || externalId !== undefined;
    const hasTier2 = domain !== undefined || type !== undefined ||
      date !== undefined;

    if (hasTier1 && hasTier2) {
      return respondWithAgentError(c, 400, [
        composeIssue("entities.ambiguous_query", {
          field: "query",
          received: { source, externalId, domain, type, date },
        }),
      ], {
        legacyFields: {
          message:
            "use either (source, external_id) or (domain, type, date) — not both",
        },
      });
    }
    if (!hasTier1 && !hasTier2) {
      return respondWithAgentError(c, 400, [
        composeIssue("entities.missing_query", {
          field: "query",
          received: "<empty>",
        }),
      ], {
        legacyFields: {
          message:
            "provide (source, external_id) or (domain, type, date) query parameters",
        },
      });
    }

    if (hasTier1) {
      // `source` alone is the bias query (Step 4a of §10.1) — list all
      // entities tagged with that source so the registration skill can
      // pick the dominant (domain, type) for `output_path`.
      // `external_id` alone is meaningless without the source key.
      if (source && !externalId) {
        let limit: number | undefined;
        if (limitRaw !== undefined) {
          const n = Number.parseInt(limitRaw, 10);
          if (!Number.isFinite(n) || n < 1) {
            return respondWithAgentError(c, 400, [
              composeIssue("entities.validation_error", {
                field: "limit",
                received: limitRaw,
                expected: "positive integer",
              }),
            ], {
              legacyFields: { message: "`limit` must be a positive integer" },
            });
          }
          limit = n;
        }
        const items = findEntitiesBySourceKey(db, source, limit);
        return c.json({
          tier: 1,
          mode: "by_source_key",
          items: items.map(toResponse),
        });
      }
      if (!source || !externalId) {
        return respondWithAgentError(c, 400, [
          composeIssue("entities.validation_error", {
            // The `source && !externalId` branch above already returns,
            // so by the time we reach here `source` is necessarily falsy
            // (only `external_id` alone could land us in this if).
            // Keep the ternary as a defensive label and ignore the dead arm.
            /* c8 ignore next */
            field: source ? "external_id" : "source",
            received: { source, externalId },
            expected: "(source, external_id) pair for tier-1 exact match",
          }),
        ], {
          legacyFields: {
            message:
              "`external_id` requires `source`; provide `source=<app>&external_id=<eid>` for tier-1 exact match, or `source=<app>` alone for the bias query",
          },
        });
      }
      const items = findEntitiesBySource(db, source, externalId);
      return c.json({
        tier: 1,
        mode: "exact",
        items: items.map(toResponse),
      });
    }

    // Tier-2 fallback — domain/type/date triple is required for the
    // structured lookup below.
    if (!domain || !type || !date) {
      return respondWithAgentError(c, 400, [
        composeIssue("entities.validation_error", {
          field: !domain ? "domain" : !type ? "type" : "date",
          received: { domain, type, date },
          expected: "tier-2 triple (domain, type, date)",
        }),
      ], {
        legacyFields: {
          message:
            "tier-2 lookup requires `domain`, `type`, and `date` (ISO YYYY-MM-DD)",
        },
      });
    }
    if (!isDomain(domain)) {
      return respondWithAgentError(c, 400, [
        composeIssue("entities.validation_error", {
          field: "domain",
          received: domain,
          expected: "registered domain enum (see Domain in @aitne/shared)",
        }),
      ], { legacyFields: { message: `unknown domain "${domain}"` } });
    }
    if (!isEntityType(type)) {
      return respondWithAgentError(c, 400, [
        composeIssue("entities.validation_error", {
          field: "type",
          received: type,
          expected: "singular entity type (e.g. 'meeting', not 'meetings')",
        }),
      ], {
        legacyFields: {
          message: `unknown type "${type}" (singular form expected, e.g. "meeting")`,
        },
      });
    }
    if (!ISO_DATE_RE.test(date)) {
      return respondWithAgentError(c, 400, [
        composeIssue("entities.validation_error", {
          field: "date",
          received: date,
          expected: "ISO YYYY-MM-DD",
          constraint: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        }),
      ], { legacyFields: { message: "`date` must be ISO YYYY-MM-DD" } });
    }
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const n = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(n) || n < 1) {
        return respondWithAgentError(c, 400, [
          composeIssue("entities.validation_error", {
            field: "limit",
            received: limitRaw,
            expected: "positive integer",
          }),
        ], {
          legacyFields: { message: "`limit` must be a positive integer" },
        });
      }
      limit = n;
    }

    const items = findEntitiesByDomainTypeDate(db, {
      domain,
      type,
      date,
      q,
      limit,
    });
    return c.json({
      tier: 2,
      q: q ?? null,
      items: items.map(toResponse),
    });
  });

  // GET /entities/by-path?path=<...> — exact lookup, 404 on miss
  app.get("/entities/by-path", (c) => {
    const path = c.req.query("path");
    if (!path) {
      return respondWithAgentError(c, 400, [
        composeIssue("entities.missing_query", {
          field: "path",
          received: "<missing>",
          expected: "vault-relative entity path",
        }),
      ], {
        legacyFields: {
          message:
            "provide `path` query parameter (e.g. work/meetings/foo.md)",
        },
      });
    }
    const item = getEntityByPath(db, path);
    if (!item) {
      return respondWithAgentError(c, 404, [
        composeIssue("entities.not_found", {
          field: "path",
          received: path,
        }),
      ]);
    }
    return c.json({ item: toResponse(item) });
  });

  return app;
}

export function buildEntitiesRoutesDepsFromApi(
  deps: ApiDependencies,
): EntitiesRoutesDeps {
  return { db: deps.db };
}
