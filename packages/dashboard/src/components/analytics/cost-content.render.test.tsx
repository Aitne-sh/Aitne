import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DelegatedProxyAsymmetryFootnote } from "./cost-content";

/**
 * DELEGATED-MODE-V2-DESIGN.md §7.2 — verbatim US-English contract
 * (Decision Log #11). The footnote sets user expectations that
 * same-backend native MCP traffic does not appear in delegated-proxy
 * telemetry; rewording would mislead users into reading "no rows" as
 * "no usage." Asserting load-bearing phrases keeps the contract from
 * drifting silently.
 */
describe("DelegatedProxyAsymmetryFootnote — §7.2 literal-copy contract", () => {
  it("includes the 'cross-backend' qualifier and the 'skip the proxy' clause", () => {
    const html = renderToStaticMarkup(<DelegatedProxyAsymmetryFootnote />);
    expect(html).toContain("cross-backend");
    expect(html).toContain("delegated-proxy telemetry");
    expect(html).toContain("skip the proxy");
    expect(html).toContain("parent session");
    expect(html).toContain("Per-tool cost isn");
  });

  it("uses Codex as the worked example so a Codex DM × Codex Gmail user recognizes their own setup", () => {
    const html = renderToStaticMarkup(<DelegatedProxyAsymmetryFootnote />);
    expect(html).toContain("Codex DM");
    expect(html).toContain("Codex");
  });
});
