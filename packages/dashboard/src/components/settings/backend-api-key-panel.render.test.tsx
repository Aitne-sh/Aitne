import type React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BackendApiKeyPanel } from "./backend-api-key-panel";

/**
 * Static-markup smoke tests for the API key panel. The panel hits
 * `/backends/:id/api-key` via TanStack Query, but on the server-rendered
 * first paint the query is still pending — so we render against a query
 * client with no fetcher and verify the loading + structural fallback.
 *
 * The branch logic (status copy, save/clear gating, format hints) is
 * exercised by `backend-api-key-panel.logic.test.ts`. These tests just
 * guard the prop wiring + shell.
 */
function render(node: React.ReactElement): string {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

describe("BackendApiKeyPanel", () => {
  it("renders a header and primary env var for each backend", () => {
    // Claude in the default direct-API-key tab references ANTHROPIC_API_KEY
    // in the description copy. The cloud-provider tabs (Bedrock / Vertex /
    // Foundry) are only described when the operator selects them in the
    // Select dropdown — server-side render captures only the active tab.
    const claude = render(<BackendApiKeyPanel backendId="claude" />);
    expect(claude).toContain("Provider auth");
    expect(claude).toContain("ANTHROPIC_API_KEY");

    const codex = render(<BackendApiKeyPanel backendId="codex" />);
    expect(codex).toContain("OPENAI_API_KEY");

    const gemini = render(<BackendApiKeyPanel backendId="gemini" />);
    // The panel lists both Gemini env aliases so the operator knows
    // both will be populated when they save.
    expect(gemini).toContain("GEMINI_API_KEY");
    expect(gemini).toContain("GOOGLE_API_KEY");
  });

  it("renders the input and Save button inline (no collapsible)", () => {
    const html = render(<BackendApiKeyPanel backendId="claude" />);
    expect(html).toContain("Provider auth");
    expect(html).toContain("(optional)");
    // The input and Save button are always visible — the operator can
    // skip them but they don't have to expand a Collapsible to discover
    // the field.
    expect(html).toContain("Save provider");
    expect(html).toContain('type="password"');
  });

  it("renders a loading state while the query is pending", () => {
    // No fetcher is wired up, so the query stays in `loading` indefinitely.
    // The status line should reflect that without crashing.
    const html = render(<BackendApiKeyPanel backendId="claude" />);
    expect(html).toContain("Loading…");
  });
});
