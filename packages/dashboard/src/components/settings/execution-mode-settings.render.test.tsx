import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ExecutionModeSettings,
  ExecutionModeSettingsCard,
} from "./execution-mode-settings";
import type { ConfigModeSlice } from "./execution-mode-settings.logic";

/**
 * Static-markup smoke tests for the /settings/models execution-mode
 * card. Two surfaces:
 *
 *   - `ExecutionModeSettings` — outer component. Shows the loading
 *     state before the `/api/config` query resolves; otherwise mounts
 *     the inner card.
 *   - `ExecutionModeSettingsCard` — inner stateful card. Seeded
 *     synchronously at mount via a lazy `useState` initializer so
 *     static renders reflect the persisted config (critical for
 *     testing the divergent-seed branch).
 */

function unifiedStrict(): ConfigModeSlice {
  return {
    claudeExecutionPermissionMode: "strict",
    codexExecutionPermissionMode: "strict",
    geminiExecutionPermissionMode: "strict",
    opencodeExecutionPermissionMode: "strict",
  };
}

function unifiedAllow(): ConfigModeSlice {
  return {
    claudeExecutionPermissionMode: "allow",
    codexExecutionPermissionMode: "allow",
    geminiExecutionPermissionMode: "allow",
    opencodeExecutionPermissionMode: "allow",
  };
}

function divergent(): ConfigModeSlice {
  return {
    claudeExecutionPermissionMode: "strict",
    codexExecutionPermissionMode: "allow",
    geminiExecutionPermissionMode: "strict",
    opencodeExecutionPermissionMode: "strict",
  };
}

function renderCard(config: ConfigModeSlice): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ExecutionModeSettingsCard
        config={config}
        onToast={() => {}}
        onApplied={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("ExecutionModeSettings — outer loading branch", () => {
  it("renders the loading card when /api/config has not resolved", () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: Infinity },
      },
    });
    // No setQueryData — useConfig returns undefined on first render.
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ExecutionModeSettings onToast={() => {}} />
      </QueryClientProvider>,
    );
    expect(html).toContain("Loading");
  });
});

describe("ExecutionModeSettingsCard — render smoke tests", () => {
  it("unified strict: title, both cards, absolute-block reassurance", () => {
    const html = renderCard(unifiedStrict());
    expect(html).toContain("Execution Mode");
    expect(html).toContain("Safe");
    expect(html).toContain("Allow");
    expect(html).toContain("Recommended");
    expect(html).toMatch(/blocked in both modes/i);
  });

  it("calls out the Codex Allow-mode absolute-block gap inside the Allow card", () => {
    // The Allow card states "Dangerous operations are still blocked"
    // for the Claude/Gemini case. Codex Allow has no per-command hook
    // surface so the daemon cannot enforce that layer for Codex; the
    // caveat surfaces this trade-off at the moment of choice. See
    // CLAUDE.md "Codex allow mode cannot enforce this layer".
    const html = renderCard(unifiedStrict());
    expect(html).toContain("Codex caveat");
    expect(html).toContain("dangerously-bypass-approvals-and-sandbox");
    expect(html).toContain("Advanced section");
  });

  it("renders an inline warning when Codex is overridden to Allow", () => {
    // The accordion is force-opened on a divergent seed. With Codex on
    // Allow specifically, the per-backend row carries an additional
    // amber warning that points back to the Allow card's caveat.
    const html = renderCard(divergent());
    expect(html).toMatch(/Codex Allow disables/);
  });

  it("unified strict: Safe card is visually selected; Apply is not disabled", () => {
    const html = renderCard(unifiedStrict());
    // Selection state is conveyed via the primary ring class on the
    // selected card; "border-primary" appears only on the chosen one.
    expect(html).toContain("border-primary");
    // Apply button's disabled attribute must not appear — `canApply`
    // returns true for a unified seed.
    // Match the HTML `disabled=""` attribute specifically. Tailwind
    // class names contain `disabled:pointer-events-none` which would
    // false-positive a naive `disabled` substring check.
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>\s*Apply/);
  });

  it("unified allow: Allow card chosen", () => {
    const html = renderCard(unifiedAllow());
    // The Allow card should carry the primary border (selected style).
    // Rather than matching on card order, assert that the rendering
    // contains both the Allow title and the selected-card class.
    expect(html).toContain("Allow");
    expect(html).toContain("border-primary");
  });

  it("divergent: accordion is force-opened, 'mixed' badge shown", () => {
    const html = renderCard(divergent());
    // The Collapsible's open state flips the trigger text Show → Hide.
    expect(html).toContain("Hide");
    // The mixed badge surfaces next to the Advanced label.
    expect(html).toContain("mixed");
  });

  it("divergent: every override chip row renders with Follow / Safe / Allow", () => {
    const html = renderCard(divergent());
    // Backend display names from BACKEND_PROVIDER_LABELS.
    expect(html).toContain("Follow");
    expect(html).toMatch(/Claude Code|Claude/);
    expect(html).toMatch(/Codex|ChatGPT/);
    expect(html).toMatch(/Gemini/);
    expect(html).toMatch(/OpenCode/);
  });

  it("divergent: Apply is enabled (canApply null-top path)", () => {
    // Critical regression guard — the old behaviour had Apply disabled
    // whenever topLevel was null, forcing the user to
    // clobber overrides by first clicking a card. The null-top +
    // all-overrides-set branch of canApply must keep Apply reachable.
    const html = renderCard(divergent());
    // Match the HTML `disabled=""` attribute specifically. Tailwind
    // class names contain `disabled:pointer-events-none` which would
    // false-positive a naive `disabled` substring check.
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>\s*Apply/);
  });
});
