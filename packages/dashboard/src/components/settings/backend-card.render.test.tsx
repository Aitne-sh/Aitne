import type React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BackendCard, type BackendCardProps } from "./backend-card";

/**
 * Shared render helper. BackendCard composes two widgets that need context
 * at the root: AuthStatusBadge (radix Tooltip) and CliInstallPanel
 * (TanStack Query). Providing both lets us render purely static markup
 * without booting jsdom.
 */
function render(card: React.ReactElement): string {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>{card}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/**
 * Static-markup smoke tests for the shared BackendCard (SETUP-UI-
 * CONSOLIDATION-DESIGN.md §7). Covers the branch points we can not
 * already guard via `backend-card.logic.test.ts`:
 *
 *   - Recommended / MAIN pills in the header
 *   - Allow-mode badge + `#execution-mode` anchor (settings mode only)
 *   - CliInstallPanel vs "CLI installed" switch
 *   - Non-main wizard "configure later" hint
 *   - Settings-mode Advanced slot plumbing via `renderExtra`
 *
 * Real click flow (radios, dropdowns) is exercised in the browser —
 * static markup is enough to catch "the prop wiring broke" regressions.
 */

function baseProps(
  overrides: Partial<BackendCardProps> = {},
): BackendCardProps {
  return {
    backendId: "claude",
    mode: "settings",
    isMain: true,
    authStatus: "ok",
    cliInstalled: true,
    enabled: true,
    webSearchEnabled: false,
    webSearchSupported: true,
    permissionMode: "strict",
    onVerifyInstall: () => {},
    onToggleEnable: () => {},
    onToggleWebSearch: () => {},
    ...overrides,
  };
}

describe("BackendCard — header pills", () => {
  it("renders MAIN pill when isMain=true, and Recommended pill for Claude", () => {
    const html = render(<BackendCard {...baseProps()} />);
    expect(html).toContain("MAIN");
    expect(html).toContain("Recommended");
  });

  it("omits the MAIN pill when isMain=false", () => {
    const html = render(<BackendCard {...baseProps({ isMain: false })} />);
    expect(html).not.toContain(">MAIN<");
  });

  it("does not render Recommended on non-Claude cards", () => {
    const html = render(
      <BackendCard {...baseProps({ backendId: "codex", isMain: false })} />,
    );
    expect(html).not.toContain("Recommended");
  });
});

describe("BackendCard — upstream deprecation notice", () => {
  it("renders the Gemini upstream-deprecation badge and reason paragraph", () => {
    // Google I/O 2026 announced Gemini CLI free/Pro/Ultra sunset on
    // 2026-06-18. Both wizard and /settings/models embed this card, so a
    // single regression guard here covers every selection surface that
    // shares the BackendCard.
    const html = render(
      <BackendCard {...baseProps({ backendId: "gemini", isMain: false })} />,
    );
    expect(html).toContain("Vendor deprecation");
    expect(html).toContain("2026-06-18");
    expect(html).toMatch(/Antigravity CLI/);
  });

  it("does not render the deprecation surface on backends without an upstream notice", () => {
    const claudeHtml = render(<BackendCard {...baseProps()} />);
    expect(claudeHtml).not.toContain("Vendor deprecation");
    const codexHtml = render(
      <BackendCard {...baseProps({ backendId: "codex", isMain: false })} />,
    );
    expect(codexHtml).not.toContain("Vendor deprecation");
  });
});

describe("BackendCard — Allow-mode badge", () => {
  it("renders Allow pill with #execution-mode anchor when permissionMode='allow'", () => {
    // Regression guard for the anchor-link behaviour (§3.1 + §3.3):
    // clicking the pill must jump to the Execution Mode card on the same
    // page. If this regresses, the badge still renders but the anchor is
    // lost — silent UX drop.
    const html = render(
      <BackendCard {...baseProps({ permissionMode: "allow" })} />,
    );
    expect(html).toContain("Allow");
    expect(html).toMatch(/href="#execution-mode"/);
  });

  it("does not render Allow pill when permissionMode='strict'", () => {
    const html = render(<BackendCard {...baseProps()} />);
    expect(html).not.toMatch(/href="#execution-mode"/);
  });

  it("never renders the Allow pill in wizard mode (badge is settings-only)", () => {
    const html = render(
      <BackendCard
        {...baseProps({ mode: "wizard", permissionMode: "allow", isMain: true })}
      />,
    );
    expect(html).not.toMatch(/href="#execution-mode"/);
  });
});

describe("BackendCard — CLI install vs verify install", () => {
  it("shows CliInstallPanel when cliInstalled=false", () => {
    const html = render(
      <BackendCard
        {...baseProps({ cliInstalled: false, authStatus: "unknown" })}
      />,
    );
    // CliInstallPanel's compact body includes a Select placeholder — the
    // exact text isn't load-bearing, but "CLI installed" must NOT appear.
    expect(html).not.toContain("CLI installed");
  });

  it("shows 'CLI installed' marker when cliInstalled=true", () => {
    const html = render(<BackendCard {...baseProps()} />);
    expect(html).toContain("CLI installed");
  });

  it("renders the Verify install button regardless of CLI state", () => {
    // shouldEnableVerifyInstall lets the user click even with the CLI
    // missing — the server-side handler returns a clean "not installed"
    // diagnostic, which is more useful than a disabled button.
    const html = render(
      <BackendCard {...baseProps({ cliInstalled: false })} />,
    );
    expect(html).toMatch(/Verify install/);
  });

  it("renders the prominent verify-install callout when CLI is on PATH but not yet verified to run", () => {
    // CTA prominence regression guard: when the CLI is present but the
    // user hasn't yet confirmed it can launch, the row swaps to a
    // bordered callout. Once `installCheck.status === 'ok'` the callout
    // collapses back into the inline row.
    const html = render(
      <BackendCard
        {...baseProps({ cliInstalled: true, authStatus: "unknown" })}
      />,
    );
    expect(html).toContain("Verify the CLI runs on this machine");
    expect(html).toMatch(/responds to/);
    expect(html).toMatch(/border-primary\/40/);
  });

  it("does not render the prominent callout once Verify install reports ok", () => {
    const html = render(
      <BackendCard
        {...baseProps({
          authStatus: "ok",
          installCheck: { status: "ok", version: "claude 1.2.3" },
        })}
      />,
    );
    expect(html).not.toContain("Verify the CLI runs on this machine");
    expect(html).toContain("CLI runs OK");
  });
});

describe("BackendCard — wizard 'configure later' hint", () => {
  it("renders the hint on a non-main wizard card with incomplete CLI/auth", () => {
    const html = render(
      <BackendCard
        {...baseProps({
          mode: "wizard",
          isMain: false,
          cliInstalled: false,
          authStatus: "unknown",
        })}
      />,
    );
    expect(html).toMatch(/install the CLI and verify it later/i);
    expect(html).toContain("/settings/models");
  });

  it("hides the hint on the main wizard card regardless of state", () => {
    const html = render(
      <BackendCard
        {...baseProps({
          mode: "wizard",
          isMain: true,
          cliInstalled: false,
          authStatus: "unknown",
        })}
      />,
    );
    expect(html).not.toMatch(/install the CLI and verify it later/i);
  });

  it("hides the hint in settings mode entirely", () => {
    const html = render(
      <BackendCard
        {...baseProps({
          mode: "settings",
          isMain: false,
          cliInstalled: false,
          authStatus: "unknown",
        })}
      />,
    );
    expect(html).not.toMatch(/install the CLI and verify it later/i);
  });
});

describe("BackendCard — renderExtra slot", () => {
  it("renders the provided slot node (used by main-card Advanced)", () => {
    const html = render(
      <BackendCard
        {...baseProps()}
        renderExtra={() => <span>__ADVANCED_SLOT__</span>}
      />,
    );
    expect(html).toContain("__ADVANCED_SLOT__");
  });

  it("omits slot wrapper when renderExtra is not passed", () => {
    const html = render(<BackendCard {...baseProps()} />);
    expect(html).not.toContain("__ADVANCED_SLOT__");
  });
});

describe("BackendCard — web-search toggle", () => {
  it("renders 'Enable web search' button when toggle is off and backend is enabled", () => {
    const html = render(
      <BackendCard
        {...baseProps({ webSearchEnabled: false, enabled: true })}
      />,
    );
    expect(html).toContain("Enable web search");
    expect(html).not.toContain("Disable web search");
  });

  it("renders 'Disable web search' button when toggle is on", () => {
    const html = render(
      <BackendCard
        {...baseProps({ webSearchEnabled: true, enabled: true })}
      />,
    );
    expect(html).toContain("Disable web search");
    expect(html).not.toContain("Enable web search");
  });

  it("renders the per-backend description so users know what they're enabling", () => {
    // Codex was the original missing case — its description must explain
    // that web search works in safe (sandbox) mode, since that was the
    // surprise the user hit before this fix landed. (React encodes the
    // straight apostrophe, so assertions match on substrings that avoid
    // the encoded character.)
    const codexHtml = render(
      <BackendCard
        {...baseProps({ backendId: "codex", isMain: false })}
      />,
    );
    expect(codexHtml).toContain("web_search tool");
    expect(codexHtml).toContain("safe (sandbox) mode");

    const claudeHtml = render(<BackendCard {...baseProps()} />);
    expect(claudeHtml).toContain("built-in WebSearch tool");

    const geminiHtml = render(
      <BackendCard
        {...baseProps({ backendId: "gemini", isMain: false })}
      />,
    );
    expect(geminiHtml).toContain("google_web_search");
  });

  it("warns the user to enable the backend first when supported but disabled", () => {
    // Without the warning, the disabled toggle button just looks broken —
    // the user can't tell whether the toggle is gated on backend-enable
    // or on something else.
    const html = render(
      <BackendCard
        {...baseProps({ webSearchSupported: true, enabled: false })}
      />,
    );
    expect(html).toContain("Enable the backend first");
  });

  it("renders 'Not supported' badge with explanation when backend lacks web search", () => {
    const html = render(
      <BackendCard {...baseProps({ webSearchSupported: false })} />,
    );
    expect(html).toContain("Not supported");
    expect(html).toContain("does not expose a web-search tool");
  });

  it("does not render the web-search panel in wizard mode", () => {
    // Wizard mode is identity + auth + verify only — toggles live on
    // /settings/models. Regression guard against accidentally widening
    // the wizard surface.
    const html = render(
      <BackendCard
        {...baseProps({ mode: "wizard" })}
      />,
    );
    expect(html).not.toContain("Enable web search");
    expect(html).not.toContain("Disable web search");
  });

  it("omits the web-search panel when onToggleWebSearch is not provided", () => {
    const { onToggleWebSearch: _omit, ...rest } = baseProps();
    const html = render(<BackendCard {...rest} />);
    expect(html).not.toContain("Enable web search");
    expect(html).not.toContain("Disable web search");
  });
});
