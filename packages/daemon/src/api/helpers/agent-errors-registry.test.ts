import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AGENT_ERROR_REGISTRY,
  type AgentErrorCode,
} from "./agent-errors-registry.js";
import type { AgentErrorRegistryEntry } from "./agent-errors-types.js";

// ── AGENT_ERROR_REGISTRY shape + content invariants ──────────────────────────
//
// Peer tests for `agent-errors-registry.ts`. Pinned invariants:
//   1. Every entry carries hint / expected / skillAnchor (composeIssue
//      relies on these defaults; missing values would silently degrade
//      every error response that uses the code).
//   2. Every code is `<namespace>.<slug>` (the translator builds codes
//      like `schedule.<field>_missing` — a malformed namespace would
//      look up nothing and surface a placeholder).
//   3. No skillAnchor still points at a Phase-4-deleted skill slug
//      (`travel`, `receipts`, `management-task-*` were merged or
//      removed; an anchor that names one would land the agent on a
//      missing file and re-loop).
//   4. Every `schedule.*` entry carries a `docsUrl` matching the
//      naming convention `errors.md#<code-tail>`.
//   5. Every `docsUrl` fragment actually resolves to an anchor in
//      its target file (catches drift between the registry and the
//      `errors.md` page after edits).
//   6. `AgentErrorCode` resolves to a literal union of registry keys
//      — not widened to `string`. Type-level pin only.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../../");

describe("registry coverage", () => {
  it("every registry entry has hint, expected, skillAnchor", () => {
    for (const [code, entry] of Object.entries(AGENT_ERROR_REGISTRY) as [string, AgentErrorRegistryEntry][]) {
      expect(entry.hint, `${code}.hint`).toBeTruthy();
      expect(entry.expected, `${code}.expected`).toBeTruthy();
      expect(entry.skillAnchor, `${code}.skillAnchor`).toBeTruthy();
    }
  });

  it("every code is namespaced under a resource prefix", () => {
    // Phase 1 ships schedule.* and agent_actions.*; subsequent passes
    // can extend the registry with context.*, observations.*, etc.
    // The invariant is "every code has a resource prefix + dot" — the
    // exact namespaces grow over time as endpoints adopt the envelope.
    for (const code of Object.keys(AGENT_ERROR_REGISTRY)) {
      expect(code, "code namespace").toMatch(/^[a-z][a-z_]*\.[a-z][a-z0-9_]*$/);
    }
  });

  /**
   * docs/design/appendices/skills-improvement.md §9-§11 + §14 deleted the standalone
   * `travel` / `travel-time` / `receipts` / `management-task-{register,
   * modify,stop}` skill slugs (merged into `gmail-lifestyle` and
   * `managed-tasks` respectively). Any registry entry still pointing
   * the agent at one of those slugs would send it to a `Read` target
   * that no longer exists. This regression guard pins the invariant
   * for every future skill merge: the deleted-slug list grows here,
   * and any anchor still naming a tombstoned slug fails the build.
   *
   * Sub-anchors are matched on the slug prefix only (`<slug>#...`),
   * so the test catches both `travel-bookings#crud` and the rarer
   * `travel-bookings` (no sub-anchor) shape.
   */
  it("no skillAnchor points at a Phase-4-deleted skill slug", () => {
    const DELETED_SLUGS: ReadonlyArray<string> = [
      "travel",
      "travel-bookings",
      "travel-time",
      "receipts",
      "management-task-register",
      "management-task-modify",
      "management-task-stop",
    ];
    const violations: string[] = [];
    for (const [code, entry] of Object.entries(AGENT_ERROR_REGISTRY) as [string, AgentErrorRegistryEntry][]) {
      const anchor = entry.skillAnchor;
      if (!anchor) continue;
      const slug = anchor.split("#", 1)[0];
      if (DELETED_SLUGS.includes(slug)) {
        violations.push(`${code}: ${anchor}`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  /**
   * SCHEDULE_API_REDESIGN_PLAN.md §5 + Phase C — every `schedule.*`
   * registry entry must carry a `docsUrl` pointing at the matching
   * anchor in `agent-assets/skills/schedule/references/errors.md`,
   * because Phase D's `validateModelToken` consumers attach
   * `validValues` and rely on the docs link to land the LLM on the
   * code-specific recovery prose. The convention is
   * `agent-assets/skills/schedule/references/errors.md#<code-tail>`
   * where the tail strips the `schedule.` namespace prefix. This
   * regression test pins both invariants.
   */
  it("every schedule.* entry has a docsUrl pointing at the per-code anchor in errors.md", () => {
    const violations: string[] = [];
    for (const [code, entry] of Object.entries(AGENT_ERROR_REGISTRY) as [string, AgentErrorRegistryEntry][]) {
      if (!code.startsWith("schedule.")) continue;
      const tail = code.slice("schedule.".length);
      const expected = `agent-assets/skills/schedule/references/errors.md#${tail}`;
      if (entry.docsUrl !== expected) {
        violations.push(`${code}: got ${entry.docsUrl ?? "<missing>"} — expected ${expected}`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  /**
   * SCHEDULE_API_REDESIGN_PLAN.md §5 + Phase C — `docsUrl` only earns
   * its keep if the anchor it points at actually resolves. The sibling
   * test above pins the *naming convention*; this one pins the
   * *physical existence* of the target. Without this, a new
   * `schedule.foo` entry can ship with `docsUrl=...#foo` while the
   * matching `<a id="foo">` in errors.md is missing — agents would
   * follow the link, land on the top of the page, and re-loop.
   *
   * Scope is intentionally narrow: every registry entry whose
   * `docsUrl` points into an `agent-assets/skills/.../errors.md`
   * file must have its fragment resolve to an `<a id="...">` anchor
   * (or to a Markdown heading with the matching kebab-slug id) in
   * that file. Off-repo URLs are skipped; missing files fail loudly.
   */
  it("every registry docsUrl fragment resolves to an anchor in its target file", () => {
    const fragmentRegex = /id="([^"]+)"/g;
    const fileCache = new Map<string, Set<string> | null>();

    function loadAnchors(filePath: string): Set<string> | null {
      if (fileCache.has(filePath)) return fileCache.get(filePath) ?? null;
      if (!existsSync(filePath)) {
        fileCache.set(filePath, null);
        return null;
      }
      const body = readFileSync(filePath, "utf8");
      const anchors = new Set<string>();
      for (const match of body.matchAll(fragmentRegex)) anchors.add(match[1]);
      fileCache.set(filePath, anchors);
      return anchors;
    }

    const violations: string[] = [];
    for (const [code, entry] of Object.entries(AGENT_ERROR_REGISTRY) as [string, AgentErrorRegistryEntry][]) {
      if (!entry.docsUrl) continue;
      // Only inspect repo-relative paths into the schedule errors page
      // (and any future per-skill errors.md sibling). Absolute URLs
      // and non-errors.md targets are out of scope for this guard.
      if (!entry.docsUrl.includes("/errors.md#")) continue;
      const [relPath, fragment] = entry.docsUrl.split("#", 2);
      if (!fragment) {
        violations.push(`${code}: docsUrl has no fragment — got ${entry.docsUrl}`);
        continue;
      }
      const filePath = resolve(REPO_ROOT, relPath);
      const anchors = loadAnchors(filePath);
      if (anchors === null) {
        violations.push(`${code}: target file does not exist — ${filePath}`);
        continue;
      }
      if (!anchors.has(fragment)) {
        violations.push(
          `${code}: anchor #${fragment} not found in ${relPath} (existing: ${
            Array.from(anchors).sort().join(", ") || "<none>"
          })`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  /**
   * FILE_SPLIT_PLAN_AGENT_ERRORS.md §9 — `AgentErrorCode` must remain a
   * literal union of registry keys, not widen to `string`, after the
   * registry moved into its own module. Type-level only; the runtime
   * `expect(true).toBe(true)` exists so vitest counts the spec — the
   * real assertion happens at compile time via the `extends` check
   * below. If the registry ever loses its `as const satisfies`
   * narrowing, this stops compiling and the gate fails before the
   * runtime assertion is reached.
   */
  it("AgentErrorCode resolves to the literal union of registry keys (compile-time pin)", () => {
    type _PinKnownCode = "schedule.scheduled_for_in_past" extends AgentErrorCode
      ? true
      : false;
    type _RejectUnknownCode = "nonexistent.unregistered_code" extends AgentErrorCode
      ? false
      : true;
    const _knownOk: _PinKnownCode = true;
    const _unknownRejected: _RejectUnknownCode = true;
    expect(_knownOk && _unknownRejected).toBe(true);
  });
});
