"use client";

import { cn } from "@/lib/utils";

/**
 * Hard cap on the `character` config value. Mirrors the Zod `.max(1000)`
 * refinement in `packages/daemon/src/settings/runtime-settings.ts` — the
 * server is the authority; the client counter is UX only. See
 * `docs/design/15-character.md` §15.3.
 */
export const CHARACTER_MAX_LENGTH = 1000;

interface CharacterEditorProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Minimum textarea height in rows. */
  rows?: number;
}

/**
 * Shared controlled textarea + live `{count}/1000` counter used by the
 * settings page and the setup wizard. Counter transitions:
 *   - below cap: muted foreground
 *   - at cap:    amber
 *   - over cap:  destructive
 *
 * Consumers compute their own save-disabled flag from the value length
 * (exported via `isCharacterOverCap`) — the component itself is purely
 * a controlled input.
 */
export function CharacterEditor({
  value,
  onChange,
  disabled = false,
  placeholder,
  rows = 6,
}: CharacterEditorProps) {
  const count = value.length;
  const overCap = count > CHARACTER_MAX_LENGTH;
  const atCap = count === CHARACTER_MAX_LENGTH;

  return (
    <div className="space-y-1">
      <textarea
        data-testid="character-editor-textarea"
        className="w-full rounded border border-input bg-background p-3 text-sm font-mono resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ minHeight: `${rows * 24}px` }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={
          placeholder ??
          "How should the agent talk to you? E.g. 'Speak casually. Tight bullets, no emoji. Use plain language for technical terms.'"
        }
      />
      <div className="flex justify-end">
        <span
          data-testid="character-editor-counter"
          aria-live="polite"
          className={cn(
            "text-xs tabular-nums",
            overCap
              ? "font-semibold text-destructive"
              : atCap
                ? "text-amber-600"
                : "text-muted-foreground",
          )}
        >
          {count}/{CHARACTER_MAX_LENGTH}
        </span>
      </div>
    </div>
  );
}

/** True when the value exceeds the server-enforced cap. */
export function isCharacterOverCap(value: string): boolean {
  return value.length > CHARACTER_MAX_LENGTH;
}
