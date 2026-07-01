/**
 * FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P3.2 — render the event-detail "Turns"
 * cell so a turn-limited pre-pass row reads "10 / 10" (with a "turn limit"
 * flag) instead of a bare "10". The envelope (the denominator) is persisted on
 * `agent_actions.detail.prePass.maxTurns` for pre-pass rows by the fan-out
 * runner; rows without an envelope (non-pre-pass, or legacy rows written before
 * P3.2) fall back to the bare count. Pure so the dashboard convention — logic
 * in `src/lib/*` with a node-env `.test.ts`, no jsdom — can pin it.
 */

export interface TurnsCell {
  /** Used-turns count, or null when the row has no turn count (non-LLM row). */
  used: number | null;
  /** Turn envelope (`max_turns`) the row ran under, or null when not persisted. */
  cap: number | null;
  /** True iff the row was killed at its envelope (`used >= cap`, `cap > 0`). */
  atLimit: boolean;
  /** Preformatted label: "—" | "8" | "8 / 20" | "10 / 10". */
  label: string;
}

/**
 * Pull `detail.prePass.maxTurns` out of the raw `agent_actions.detail` JSON
 * string. Fully defensive — a null/blank/malformed cell, a missing `prePass`
 * key, or a non-positive/non-finite `maxTurns` all return null (the cell then
 * renders the bare count). `maxTurns` is only meaningful when > 0.
 */
export function readMaxTurns(detail: string | null | undefined): number | null {
  if (!detail) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const prePass = (parsed as Record<string, unknown>).prePass;
  if (!prePass || typeof prePass !== "object") return null;
  const raw = (prePass as Record<string, unknown>).maxTurns;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * Compute the Turns-cell display for an event row. `used` mirrors the
 * `num_turns` column; `cap` is the persisted envelope. When both are known the
 * label is "used / cap" and `atLimit` flags a row that spent its whole budget.
 */
export function turnsCell(event: {
  num_turns: number | null;
  detail: string | null;
}): TurnsCell {
  const used =
    typeof event.num_turns === "number" && Number.isFinite(event.num_turns)
      ? event.num_turns
      : null;
  const cap = readMaxTurns(event.detail);
  if (used === null) {
    return { used: null, cap, atLimit: false, label: "—" };
  }
  if (cap === null) {
    return { used, cap: null, atLimit: false, label: String(used) };
  }
  return {
    used,
    cap,
    atLimit: used >= cap,
    label: `${used} / ${cap}`,
  };
}
