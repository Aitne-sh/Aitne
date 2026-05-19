import type { IntegrationKey } from "@aitne/shared";

/**
 * Extract the upstream item id (`eventId` / `messageId` / `threadId` /
 * `pageId`) from a delegated `/api/integrations/:key/exec` write
 * response so the route handler can mark `integration_writes`
 * (INTEGRATION-DRIFT-DETECTION-PLAN.md §11 Phase 4). The same shape
 * walk also covered the retired `/invoke` RPC handler; defensive guards
 * in `exec.ts:maybeMarkIntegrationWrite` are kept for any future
 * reactivation.
 *
 * The connector returns `toolResult` verbatim — and Claude / Codex /
 * Gemini wrap the upstream response differently. Rather than building a
 * per-(integration, backend, tool) routing table, this helper walks a
 * small number of canonical field names and returns the first match.
 * Returning `null` is fine: the route handler logs at debug and skips
 * the mark; the next reconcile observes the change as `actor='user'`
 * instead of `actor='agent'`. That degrades to one self-noticed
 * observation, never to data loss.
 *
 * The shape contract is therefore: *if* the connector wraps the upstream
 * id under one of `id`, `eventId`/`messageId`/`threadId`/`pageId`,
 * `event.id`/`message.id`/`thread.id`/`page.id`, or under a single
 * top-level `events`/`messages`/`pages` array of length 1, we extract.
 * Anything stranger silently returns `null`.
 */
export interface ExtractWriteItemIdsRequest {
  integration: IntegrationKey;
  /** Canonical bare tool name AFTER alias resolution
   *  (`resolveCanonicalBareTool`). The caller MUST translate first so a
   *  Claude alias on a Codex backend (e.g. `send_email` against Gemini's
   *  `send`) is correctly classified. */
  bareTool: string;
  /** Verbatim `toolResult` from `DelegatedBackendInvoker.invoke`. Any
   *  shape — array / object / scalar / null. */
  toolResult: unknown;
}

export interface ExtractedWriteItemIds {
  /** Items the route handler should mark with `markIntegrationWrite`.
   *  Empty when extraction failed or the tool is not destructive. The
   *  route handler distinguishes "non-destructive tool, no mark needed"
   *  from "destructive tool, extraction failed" via {@link reason}. */
  itemIds: string[];
  /**
   * Why the extractor returned what it did. Surfaces at debug log so
   * operators can spot connector-shape drift (a new connector update
   * starts wrapping ids under a key we don't walk).
   */
  reason:
    | "extracted"
    | "extracted_threadId_only"
    | "extracted_from_args"
    | "no_id_in_result";
}

const ID_KEYS_BY_INTEGRATION: Readonly<
  Record<IntegrationKey, readonly string[]>
> = {
  google_calendar: ["eventId", "id"],
  gmail: ["messageId", "id", "threadId"],
  notion: ["pageId", "id"],
  git: [],
  github: [],
  // Outlook integrations are direct-only in v1 (no MCP connector); the
  // delegated drift-detection path doesn't currently exercise these
  // walkers, but IntegrationKey is exhaustive so empty entries keep the
  // type system honest.
  outlook_mail: [],
  outlook_calendar: [],
};

const NESTED_KEYS_BY_INTEGRATION: Readonly<
  Record<IntegrationKey, readonly string[]>
> = {
  google_calendar: ["event"],
  gmail: ["message", "thread", "draft"],
  notion: ["page"],
  git: [],
  github: [],
  outlook_mail: [],
  outlook_calendar: [],
};

const COLLECTION_KEYS_BY_INTEGRATION: Readonly<
  Record<IntegrationKey, readonly string[]>
> = {
  google_calendar: ["events"],
  gmail: ["messages", "threads", "drafts"],
  notion: ["pages", "results"],
  git: [],
  github: [],
  outlook_mail: [],
  outlook_calendar: [],
};

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function pluckId(obj: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const v = asString(obj[k]);
    if (v !== null) out.push(v);
  }
  return out;
}

function walk(
  toolResult: unknown,
  integration: IntegrationKey,
): string[] {
  if (toolResult === null || typeof toolResult !== "object") return [];
  const obj = toolResult as Record<string, unknown>;

  const direct = pluckId(obj, ID_KEYS_BY_INTEGRATION[integration]);
  if (direct.length > 0) return direct;

  for (const nested of NESTED_KEYS_BY_INTEGRATION[integration]) {
    const inner = obj[nested];
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      const ids = pluckId(
        inner as Record<string, unknown>,
        ID_KEYS_BY_INTEGRATION[integration],
      );
      if (ids.length > 0) return ids;
    }
  }

  for (const collection of COLLECTION_KEYS_BY_INTEGRATION[integration]) {
    const arr = obj[collection];
    if (!Array.isArray(arr)) continue;
    const out: string[] = [];
    for (const entry of arr) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const ids = pluckId(
        entry as Record<string, unknown>,
        ID_KEYS_BY_INTEGRATION[integration],
      );
      out.push(...ids);
    }
    if (out.length > 0) return out;
  }

  return [];
}

/**
 * Per-integration `args`-side fallback walkers — when a destructive
 * connector tool returns `{ ok: true }` without echoing the upstream id
 * (Claude `label_message`, Codex `apply_labels_to_emails`, Gemini
 * `modify`), we read the id off the call's arguments instead.
 *
 * Each entry lists the singular keys (single-id calls) and plural keys
 * (collection calls — the value is `string[]`). Entries are case-
 * insensitive only insofar as we list the snake_case AND camelCase
 * forms that connectors actually use; we do NOT lower-case keys, since
 * connectors uniformly stick to one or the other.
 *
 * `notion-create-pages` deliberately has no `args`-side singular id —
 * the *new* page id is only known after the connector responds, so the
 * response walker is the only path. `parent_page_id` is intentionally
 * not listed: marking the parent would suppress legitimate user edits
 * to the parent inside the TTL window.
 */
const ARGS_SINGULAR_KEYS_BY_INTEGRATION: Readonly<
  Record<IntegrationKey, readonly string[]>
> = {
  google_calendar: ["eventId", "event_id", "id"],
  gmail: ["messageId", "message_id", "threadId", "thread_id", "id"],
  notion: ["page_id", "pageId", "id"],
  git: [],
  github: [],
  outlook_mail: [],
  outlook_calendar: [],
};

const ARGS_PLURAL_KEYS_BY_INTEGRATION: Readonly<
  Record<IntegrationKey, readonly string[]>
> = {
  google_calendar: [],
  gmail: ["messageIds", "message_ids", "threadIds", "thread_ids", "ids"],
  notion: [],
  git: [],
  github: [],
  outlook_mail: [],
  outlook_calendar: [],
};

function pluckArgsIds(args: unknown, integration: IntegrationKey): string[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  const obj = args as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ARGS_SINGULAR_KEYS_BY_INTEGRATION[integration]) {
    const v = asString(obj[k]);
    if (v !== null) out.push(v);
  }
  for (const k of ARGS_PLURAL_KEYS_BY_INTEGRATION[integration]) {
    const arr = obj[k];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      const v = asString(entry);
      if (v !== null) out.push(v);
    }
  }
  return out;
}

/**
 * Pure helper. Side-effect free. Returns the ids the caller should mark.
 *
 * Resolution order:
 *   1. Walk the response shape (`extractWriteItemIds(req).itemIds`).
 *   2. If the response had no id and `req.args` is set, walk the args.
 *
 * Rules for callers:
 *   - Only invoke when the tool is in the connector's `destructiveTools`
 *     (membership decides "is this a write?" — we do not double-check).
 *   - Provide `args` for label-mutating Gmail / Notion archive / similar
 *     `{ ok: true }`-only response tools. The route handler already has
 *     them in scope, so passing them is free.
 */
export function extractWriteItemIds(
  req: ExtractWriteItemIdsRequest & { args?: unknown },
): ExtractedWriteItemIds {
  let ids = walk(req.toolResult, req.integration);
  let usedArgsFallback = false;
  if (ids.length === 0) {
    const fromArgs = pluckArgsIds(req.args, req.integration);
    if (fromArgs.length > 0) {
      ids = fromArgs;
      usedArgsFallback = true;
    }
  }
  if (ids.length === 0) {
    return { itemIds: [], reason: "no_id_in_result" };
  }
  // Dedupe while preserving order — the same id often appears under
  // both `id` and `messageId`/`eventId`/`pageId`.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  // Gmail: when only a threadId came back (no messageId / id), the next
  // reconcile keys by thread, so a threadId mark still suppresses the
  // self-notice. Surface this in `reason` so the audit log makes the
  // decision visible.
  if (
    req.integration === "gmail"
    && unique.length === 1
    && req.toolResult !== null
    && typeof req.toolResult === "object"
    && asString((req.toolResult as Record<string, unknown>).threadId) === unique[0]
    && asString((req.toolResult as Record<string, unknown>).messageId) === null
    && asString((req.toolResult as Record<string, unknown>).id) === null
  ) {
    return { itemIds: unique, reason: "extracted_threadId_only" };
  }
  return {
    itemIds: unique,
    reason: usedArgsFallback ? "extracted_from_args" : "extracted",
  };
}
