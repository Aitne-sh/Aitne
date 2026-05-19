/**
 * Cross-tuple invariant tests for the editable-config-keys registry.
 *
 * The registry is consumed by the daemon's `env-writer.ts` (PATCH /api/config
 * write side) and the dashboard's `useSaveConfig` (read side). The shape
 * relations between the three tuples are not type-checked, so a typo or a
 * mis-categorized addition can silently break the dashboard's
 * "restart-required" badge or leave a key stranded as un-PATCHable.
 *
 * These tests pin those relations so a future addition cannot drift.
 */
import { describe, it, expect } from "vitest";
import {
  EDITABLE_BOOTSTRAP_KEY_TUPLE,
  EDITABLE_RUNTIME_KEY_TUPLE,
  RESTART_REQUIRED_KEY_TUPLE,
} from "./editable-config-keys.js";

describe("editable-config-keys tuples", () => {
  it("EDITABLE_RUNTIME_KEY_TUPLE has no duplicate entries", () => {
    const set = new Set(EDITABLE_RUNTIME_KEY_TUPLE);
    expect(set.size).toBe(EDITABLE_RUNTIME_KEY_TUPLE.length);
  });

  it("EDITABLE_BOOTSTRAP_KEY_TUPLE has no duplicate entries", () => {
    const set = new Set(EDITABLE_BOOTSTRAP_KEY_TUPLE);
    expect(set.size).toBe(EDITABLE_BOOTSTRAP_KEY_TUPLE.length);
  });

  it("RESTART_REQUIRED_KEY_TUPLE has no duplicate entries", () => {
    const set = new Set(RESTART_REQUIRED_KEY_TUPLE);
    expect(set.size).toBe(RESTART_REQUIRED_KEY_TUPLE.length);
  });

  it("EDITABLE_RUNTIME and EDITABLE_BOOTSTRAP do not overlap (a key is one or the other, not both)", () => {
    // The dashboard branches on which tuple a key is in to decide whether
    // to PATCH the runtime endpoint or the bootstrap endpoint. A key that
    // appears in both creates a routing ambiguity.
    const bootstrap = new Set<string>(EDITABLE_BOOTSTRAP_KEY_TUPLE);
    const overlap = EDITABLE_RUNTIME_KEY_TUPLE.filter((k) =>
      bootstrap.has(k as string),
    );
    expect(overlap).toEqual([]);
  });

  it("every RESTART_REQUIRED_KEY_TUPLE entry is also in EDITABLE_RUNTIME or EDITABLE_BOOTSTRAP", () => {
    // A "restart required" key that is not editable at all is dead — no
    // PATCH endpoint accepts it, so the badge would never trigger. This
    // is a real bug shape (a key gets renamed in one tuple and not the
    // other), so we lock it in.
    const editable = new Set<string>([
      ...EDITABLE_RUNTIME_KEY_TUPLE,
      ...EDITABLE_BOOTSTRAP_KEY_TUPLE,
    ]);
    const stranded = RESTART_REQUIRED_KEY_TUPLE.filter(
      (k) => !editable.has(k as string),
    );
    expect(stranded).toEqual([]);
  });
});
