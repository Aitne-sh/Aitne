import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DocsHelpButton } from "./docs-help-button";

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={freshClient()}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/**
 * The button itself is dispatch-shaped — clicking writes the
 * slide-over cache cell. Click integration is exercised by the
 * cmdk-palette.actions.test (which calls the same imperative writer)
 * and by manual browser verification per CLAUDE.md. The render-side
 * smoke test here covers the two visible states.
 */
describe("DocsHelpButton — render", () => {
  it("renders nothing when docId is null", () => {
    // A null docId means "this page opts out of the help button"
    // (DOCS_QA_DASHBOARD_DESIGN.md §6.3). The button must collapse to
    // empty markup so the action strip stays uncluttered.
    const html = render(<DocsHelpButton docId={null} />);
    expect(html).not.toContain("docs-help-button");
    expect(html).not.toContain('aria-label="Open contextual help');
  });

  it("renders the help button with aria-label when a docId is supplied", () => {
    const html = render(<DocsHelpButton docId="concepts/agent-day" />);
    expect(html).toContain("docs-help-button");
    expect(html).toContain("Open contextual help for this page");
  });
});
