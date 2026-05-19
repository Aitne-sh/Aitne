/**
 * Pure helpers for the WikiVaultPathPicker — kept separate from the
 * React component so probe-summary logic is unit-testable without
 * mounting a tree.
 *
 * Selection itself is delegated to `DirectoryPickerField`, which opens
 * the OS-native folder dialog (`osascript`, `powershell`, `zenity`/
 * `kdialog`/`yad`) via `/api/system/pick-directory`. This module owns
 * the post-selection validation surface: it translates `/api/fs/probe`
 * responses into severity-tagged banner lines.
 */

/**
 * Human-readable label for a probe collision. The route returns a
 * structured `collision` code so the picker can map to localised text
 * and pick severity (error vs. warning); the original message from the
 * validator is surfaced as a tooltip when the code is `invalid`.
 */
export function describeCollision(
  collision: ProbeCollision | null,
  fallbackMessage: string | null,
): { severity: "error" | "warning" | null; text: string } | null {
  if (collision === null) return null;
  switch (collision) {
    case "primary_vault":
      return {
        severity: "error",
        text: "This path overlaps your primary memory vault. Pick a different directory.",
      };
    case "external_obsidian":
      return {
        severity: "error",
        text: "This path overlaps your external Obsidian vault. Pick a different directory.",
      };
    case "data_dir":
      return {
        severity: "error",
        text: "This path overlaps the daemon's data directory. Pick a different directory.",
      };
    case "other_wiki":
      return {
        severity: "error",
        text: "Another wiki workspace already lives here. Pick a different directory.",
      };
    case "system_path":
      return {
        severity: "error",
        text: "This path is under a system-managed location. Pick a directory inside your home folder.",
      };
    case "not_writable":
      return {
        severity: "warning",
        text:
          "This directory is not writable from the daemon. Aitne will fall back to the Obsidian CLI when it is running.",
      };
    case "invalid":
    default:
      return {
        severity: "error",
        text: fallbackMessage ?? "This path failed validation.",
      };
  }
}

/**
 * Verdict shown next to the "Use this directory" button. Combines the
 * exists/writable/collision/existing-wiki signals from the probe into
 * one summary so the user does not have to read three banners.
 */
export function summariseProbe(probe: ProbeResult | null): ProbeSummary {
  if (!probe) {
    return { canConfirm: false, lines: ["Pick a directory to validate."], severity: null };
  }
  if (!probe.ok) {
    return {
      canConfirm: false,
      lines: [probe.message ?? "Path is invalid."],
      severity: "error",
    };
  }
  const lines: string[] = [];
  let severity: "error" | "warning" | "info" | null = null;
  if (probe.collision) {
    const desc = describeCollision(probe.collision, probe.collisionMessage);
    if (desc) {
      lines.push(desc.text);
      severity = desc.severity ?? severity;
    }
  }
  if (!probe.exists) {
    lines.push("Directory will be created on save.");
    severity = severity ?? "info";
  } else if (!probe.isDir) {
    lines.push("Path exists but is not a directory.");
    severity = "error";
  } else if (!probe.writable) {
    lines.push("Directory is not writable from the daemon (Obsidian CLI fallback applies).");
    severity = severity ?? "warning";
  }
  if (probe.hasObsidianStructure) {
    lines.push("Detected an existing Obsidian vault (.obsidian directory present).");
    severity = severity ?? "info";
  }
  if (probe.existingWiki) {
    lines.push(
      `Detected an existing LLM-Wiki layout (${probe.existingWiki.layers.join(", ")}). You will be prompted to Adopt or Migrate after saving.`,
    );
    severity = severity ?? "info";
  }
  if (lines.length === 0) {
    lines.push("Directory is empty and writable. Ready to enable.");
    severity = "info";
  }
  // `canConfirm` blocks the Use-this-directory button only on hard
  // errors: validation failed, exists-but-not-dir, or collision. A
  // warning (not_writable + Obsidian CLI fallback) still lets the user
  // proceed — the daemon resolves that case at runtime.
  const canConfirm = severity !== "error" && (probe.exists ? probe.isDir : true);
  return { canConfirm, lines, severity };
}

export interface ProbeResult {
  ok: boolean;
  path: string;
  resolved?: string;
  exists: boolean;
  isDir: boolean;
  writable: boolean;
  collision: ProbeCollision | null;
  collisionMessage: string | null;
  hasObsidianStructure: boolean;
  existingWiki: {
    kind: string;
    layers: string[];
    taxonomyPresent: boolean;
    indexPresent: boolean;
    unexpectedSubdirectories: Array<{ layer: string; subdir: string }>;
  } | null;
  /** Populated when `ok` is false. */
  error?: string;
  message?: string;
}

export interface ProbeSummary {
  canConfirm: boolean;
  lines: string[];
  severity: "error" | "warning" | "info" | null;
}

export type ProbeCollision =
  | "primary_vault"
  | "external_obsidian"
  | "data_dir"
  | "other_wiki"
  | "system_path"
  | "not_writable"
  | "invalid";
