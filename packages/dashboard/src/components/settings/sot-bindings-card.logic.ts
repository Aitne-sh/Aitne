/**
 * Pure helpers for SotBindingsCard. Render-free assertions
 * (duplicate-category detection, trim semantics, replace-semantics
 * row equality) live here so the card's table logic is unit-testable
 * without React or Tanstack Query.
 *
 * The card stays the orchestration shell (state hooks, mutation glue);
 * every transformation it applies to draft rows ends up in this file.
 */

import type { SotBinding } from "@aitne/shared";

export type DraftBinding = SotBinding;
export type WriterValue = SotBinding["writer"];

export const WRITER_OPTIONS: { value: WriterValue; label: string }[] = [
  { value: "agent", label: "agent" },
  { value: "shared", label: "shared" },
  { value: "user", label: "user" },
];

export function emptyRow(): DraftBinding {
  return {
    category: "",
    sotApp: "",
    mirrorPath: null,
    policy: null,
    writer: "shared",
  };
}

/**
 * Return `null` for empty / whitespace-only input so the column is
 * stored as the daemon's `—`-rendered NULL form rather than an empty
 * string. Trim semantics match the render path's `emDashOr`.
 */
export function nullableTrim(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Structural row-equality used by the dirty-check. A no-op edit
 * (re-typing the same value) does not enable Save; an order change
 * does because §10.6 PUT replaces the full array verbatim.
 */
export function rowsEqual(a: DraftBinding[], b: DraftBinding[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.category !== y.category ||
      x.sotApp !== y.sotApp ||
      x.mirrorPath !== y.mirrorPath ||
      x.policy !== y.policy ||
      x.writer !== y.writer
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Client-side validation gate for the Save button. Mirrors the
 * server-side Zod refinements:
 *
 *   - non-empty `category` / `sotApp` (trimmed),
 *   - case-insensitive uniqueness on `category` (the daemon's renderer
 *     keys §A by category, so a duplicate would silently overwrite).
 *
 * Server-side errors still flow through the response — this is just
 * the early-exit so a clearly-broken draft can't even attempt save.
 */
export function rowsValid(
  rows: DraftBinding[],
): { ok: true } | { ok: false; reason: string } {
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.category.trim()) {
      return { ok: false, reason: `Row ${i + 1}: Category is required` };
    }
    if (!r.sotApp.trim()) {
      return { ok: false, reason: `Row ${i + 1}: SoT app is required` };
    }
    const key = r.category.trim().toLowerCase();
    if (seen.has(key)) {
      return { ok: false, reason: `Duplicate category "${r.category}"` };
    }
    seen.add(key);
  }
  return { ok: true };
}
