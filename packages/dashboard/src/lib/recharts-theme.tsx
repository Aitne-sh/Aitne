import type { ReactNode } from "react";

/**
 * Shared Recharts styling that resolves to the same CSS custom properties
 * the rest of the dashboard reads, so charts adapt to dark/light mode.
 *
 * Recharts' DefaultTooltipContent paints each item with
 * `color: entry.color || '#000'`, so any chart with no series color (Pie)
 * renders item rows in pure black — unreadable on the dark
 * `--color-card` background. Spreading `RECHARTS_TOOLTIP_*` overrides
 * the inline color with `--color-foreground`.
 *
 * DefaultLegendContent has the same issue with a twist: it sets
 * `style={{ color: entry.color }}` on the per-item `<span>`, which
 * defeats both `wrapperStyle.color` and parent-element CSS cascade.
 * The only override path that survives is a `formatter` that wraps the
 * label in its own coloured span — that's what `legendLabel` does.
 */
export const RECHARTS_TOOLTIP_CONTENT_STYLE = {
  backgroundColor: "var(--color-card)",
  border: "1px solid var(--color-border)",
  borderRadius: "8px",
  color: "var(--color-foreground)",
} as const;

export const RECHARTS_TOOLTIP_ITEM_STYLE = {
  color: "var(--color-foreground)",
} as const;

export const RECHARTS_TOOLTIP_LABEL_STYLE = {
  color: "var(--color-foreground)",
} as const;

/**
 * Recharts' default Tooltip `cursor` for bar/composed charts is a light
 * gray rectangle (`#ccc` at low opacity) that reads as near-white over
 * the dark card background. A translucent foreground overlay adapts to
 * both light and dark themes — visible without overpowering the bar
 * colors.
 *
 * Use on Bar/Composed charts:
 *     <Tooltip cursor={RECHARTS_TOOLTIP_CURSOR_FILL} ... />
 *
 * Use on Line/Area charts (the cursor is a vertical stroke, not a fill):
 *     <Tooltip cursor={RECHARTS_TOOLTIP_CURSOR_STROKE} ... />
 */
export const RECHARTS_TOOLTIP_CURSOR_FILL = {
  fill: "var(--color-foreground)",
  fillOpacity: 0.08,
} as const;

export const RECHARTS_TOOLTIP_CURSOR_STROKE = {
  stroke: "var(--color-foreground)",
  strokeOpacity: 0.25,
} as const;

/**
 * Wrap a Legend item label in a foreground-coloured span. Use as the
 * Legend's `formatter`:
 *
 *     <Legend formatter={legendLabel} />
 *     <Legend formatter={(v) => legendLabel(getBackendShortLabel(v))} />
 *
 * The series colour is preserved on the icon (square/circle) — only
 * the text is overridden.
 */
export function legendLabel(value: ReactNode): ReactNode {
  return <span style={{ color: "var(--color-foreground)" }}>{value}</span>;
}
