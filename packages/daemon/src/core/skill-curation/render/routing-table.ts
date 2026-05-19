// P22 §1.4.5 — routing_table renderer.
//
// Three-column table (Trigger | Destination | Mode) when ≥3 rules; bullet
// form below that. Notes render as numbered footnotes below the table to
// keep column widths stable.

import type { RoutingTableValue } from "@aitne/shared";

export const RENDERER_VERSION = "routing_table/1";

const TABLE_THRESHOLD = 3;

function destination(rule: RoutingTableValue["rules"][number]): string {
  return `\`${rule.destination_path} ${rule.destination_section}\``;
}

export function renderRoutingTable(payload: RoutingTableValue): string {
  const { rules } = payload;
  if (rules.length === 0) return "";

  if (rules.length >= TABLE_THRESHOLD) {
    const footnotes: string[] = [];
    const header = "| Trigger | Destination | Mode |";
    const sep = "|---|---|---|";
    const rows = rules.map((rule, idx) => {
      const ref = rule.note ? ` [^${idx + 1}]` : "";
      if (rule.note) footnotes.push(`[^${idx + 1}]: ${rule.note}`);
      return `| ${rule.trigger_pattern}${ref} | ${destination(rule)} | ${rule.destination_mode} |`;
    });
    const out = [header, sep, ...rows];
    if (footnotes.length > 0) out.push("", ...footnotes);
    return out.join("\n");
  }

  return rules
    .map((rule) => {
      const note = rule.note ? ` — ${rule.note}` : "";
      return `- ${rule.trigger_pattern} → ${destination(rule)} (${rule.destination_mode})${note}`;
    })
    .join("\n");
}
