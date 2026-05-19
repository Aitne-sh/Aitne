// P22 §4.1 — structure-diff walker.
//
// Hourly. Walks `getContextDir(config)` once per skill in the curation
// cohort and diffs the live snapshot against the latest applied overlay
// payload. Differences become `structure_diff` signals (heading_add,
// heading_remove, file_add, file_remove, frontmatter_change).
//
// Pure rule-based — no LLM. The walker is its own test surface (`structure_diff`
// must not flag identifier-only changes after the diff classifier's normalizer
// would normalize both sides).
//
// Idempotent: a re-run of the walker on the same vault with no changes
// inserts zero new signals (existing unconsumed rows are matched by an
// `idempotency_key` extracted from the payload).

import type Database from "better-sqlite3";
import { createLogger } from "../logging.js";
import type { Observer } from "./manager.js";
import { buildKnowledgeMap, filterSnapshotByScope } from "../core/skill-curation/knowledge-map.js";
import {
  loadAllCurationDeclarations,
  type LoadedCurationDeclaration,
} from "../core/skill-curation/declarations.js";
import { OverlayStore } from "../core/skill-curation/overlay-store.js";
import { recordSignal, unconsumedSignalsForSkill } from "../core/skill-curation/signals.js";
import type { CurationPayloadValue, SectionKind } from "@aitne/shared";

const logger = createLogger("skill-curation-walker");

const ONE_HOUR_MS = 60 * 60 * 1000;

interface WalkerOptions {
  intervalMs?: number;
  /** Inject for tests. */
  now?: () => number;
}

export class SkillCurationWalker implements Observer {
  readonly name = "skill-curation-walker";
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private running = false;

  constructor(
    private readonly db: Database.Database,
    private readonly contextDir: string,
    private readonly skillsRoot: string,
    private readonly dataDir: string,
    options: WalkerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? ONE_HOUR_MS;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    // Defer first run by 60s so daemon boot is not blocked by a vault scan.
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => logger.error({ err }, "walker tick failed"));
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Public for tests + ad-hoc /api/skill-curation/walker/run. */
  async runOnce(): Promise<{ inserted: number; skills_walked: number }> {
    if (this.running) return { inserted: 0, skills_walked: 0 };
    this.running = true;
    try {
      const decls = loadAllCurationDeclarations(this.skillsRoot)
        .filter((d) => d.declaration !== null);
      if (decls.length === 0) return { inserted: 0, skills_walked: 0 };
      const snapshot = buildKnowledgeMap(this.contextDir);
      const overlay = new OverlayStore(this.dataDir, this.skillsRoot);
      let inserted = 0;
      for (const decl of decls) {
        inserted += diffSkill(this.db, decl, snapshot, overlay, this.now());
      }
      return { inserted, skills_walked: decls.length };
    } finally {
      this.running = false;
    }
  }
}

/** Exported for unit tests. */
export function diffSkill(
  db: Database.Database,
  decl: LoadedCurationDeclaration,
  snapshot: ReturnType<typeof buildKnowledgeMap>,
  overlay: OverlayStore,
  now: number,
): number {
  if (!decl.declaration) return 0;
  let inserted = 0;
  const existing = unconsumedSignalsForSkill(db, decl.slug);
  const seenKeys = new Set<string>();
  for (const sig of existing) {
    const k = (safeParse(sig.payload_json) as Record<string, unknown> | null)?.idempotency_key;
    if (typeof k === "string") seenKeys.add(k);
  }

  for (const section of decl.declaration.sections) {
    const live = filterSnapshotByScope(snapshot, section.scope_paths);
    const payload = overlay.readPayload(decl.slug, section.id, section.kind);
    const observations = collectObservations(section.kind, payload, live);
    for (const obs of observations) {
      const idempotencyKey = `${decl.slug}:${section.id}:${obs.sub_kind}:${obs.target}`;
      if (seenKeys.has(idempotencyKey)) continue;
      recordSignal(db, {
        skill_slug: decl.slug,
        section_id: section.id,
        signal_type: "structure_diff",
        payload: { ...obs, idempotency_key: idempotencyKey },
        observed_at: now,
      });
      seenKeys.add(idempotencyKey);
      inserted++;
    }
  }
  return inserted;
}

interface StructureObservation {
  sub_kind:
    | "file_add"
    | "file_remove"
    | "heading_add"
    | "heading_remove"
    | "frontmatter_change";
  target: string;
  detail?: unknown;
}

function collectObservations(
  kind: SectionKind,
  payload: CurationPayloadValue | null,
  live: ReturnType<typeof filterSnapshotByScope>,
): StructureObservation[] {
  const out: StructureObservation[] = [];

  switch (kind) {
    case "knowledge_layout": {
      const knownPaths = new Set<string>();
      const knownHeadings = new Map<string, Set<string>>();
      if (payload && payload.kind === "knowledge_layout") {
        for (const f of payload.files) {
          knownPaths.add(f.path.toLowerCase());
          knownHeadings.set(
            f.path.toLowerCase(),
            new Set(f.sections.map((s) => stripHeading(s.heading))),
          );
        }
      }
      const livePaths = new Set(live.map((f) => f.path.toLowerCase()));
      for (const lp of livePaths) {
        if (!knownPaths.has(lp)) out.push({ sub_kind: "file_add", target: lp });
      }
      for (const kp of knownPaths) {
        if (!livePaths.has(kp)) out.push({ sub_kind: "file_remove", target: kp });
      }
      for (const f of live) {
        const known = knownHeadings.get(f.path.toLowerCase());
        if (!known) continue; // file_add reported above
        const liveHeadings = new Set(f.headings);
        for (const h of liveHeadings) {
          if (!known.has(h)) out.push({ sub_kind: "heading_add", target: `${f.path}#${h}` });
        }
        for (const h of known) {
          if (!liveHeadings.has(h)) out.push({ sub_kind: "heading_remove", target: `${f.path}#${h}` });
        }
      }
      break;
    }
    case "frontmatter_schema": {
      if (payload && payload.kind === "frontmatter_schema") {
        for (const ft of payload.file_types) {
          for (const f of live.filter((lf) => simpleGlobMatch(lf.path, ft.glob))) {
            const present = new Set(Object.keys(f.frontmatter));
            for (const required of ft.required) {
              if (!present.has(required.key)) {
                out.push({ sub_kind: "frontmatter_change", target: `${f.path}#${required.key}`, detail: { missing: true } });
              }
            }
          }
        }
      }
      break;
    }
    case "routing_table":
    case "search_recipes": {
      if (payload) {
        const known = (() => {
          if (payload.kind === "routing_table") return payload.rules.map((r) => r.destination_path.toLowerCase());
          /* c8 ignore next 2 */
          if (payload.kind === "search_recipes") return payload.recipes.map((r) => r.lookup_path.toLowerCase());
          return [] as string[];
        })();
        const livePaths = new Set(live.map((f) => f.path.toLowerCase()));
        for (const k of known) {
          if (k.includes("*")) continue;
          if (!livePaths.has(k) && !live.some((f) => f.path.toLowerCase().endsWith("/" + k))) {
            out.push({ sub_kind: "file_remove", target: k });
          }
        }
      }
      break;
    }
    case "convention_notes":
    case "cross_references": {
      // No structural diff: conventions are statements of fact, cross-refs
      // are owner-curated. Walker emits no signals; other channels (owner
      // correction, agent feedback) drive these kinds.
      break;
    }
  }
  return out;
}

function stripHeading(s: string): string {
  return s.replace(/^##{1,2}\s+/, "").trim();
}

function simpleGlobMatch(path: string, pattern: string): boolean {
  if (!pattern.includes("*")) return path === pattern;
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*") +
      "$",
  );
  return re.test(path);
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
