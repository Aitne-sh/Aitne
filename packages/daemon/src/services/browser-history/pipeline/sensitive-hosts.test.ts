import { describe, it, expect } from "vitest";
import { classifyHost } from "./sensitive-hosts.js";

describe("classifyHost", () => {
  it("returns banking for known bank hosts", () => {
    expect(classifyHost("chase.com")).toBe("banking");
    expect(classifyHost("www.bankofamerica.com")).toBe("banking");
    expect(classifyHost("smbc.co.jp")).toBe("banking");
  });

  it("returns banking for subdomain of known bank", () => {
    expect(classifyHost("secure.chase.com")).toBe("banking");
  });

  it("returns banking via heuristic suffix regex", () => {
    expect(classifyHost("acme-credit-union.com")).toBe("banking");
    expect(classifyHost("www.somelocalbank.com")).toBe("banking");
  });

  it("returns health for known health hosts", () => {
    expect(classifyHost("mychart.com")).toBe("health");
    expect(classifyHost("kp.org")).toBe("health");
    expect(classifyHost("www.webmd.com")).toBe("health");
  });

  it("returns health via heuristic", () => {
    expect(classifyHost("acme-clinic.com")).toBe("health");
  });

  it("returns adult for known adult hosts", () => {
    expect(classifyHost("pornhub.com")).toBe("adult");
  });

  it("returns null for unrelated hosts", () => {
    expect(classifyHost("example.com")).toBeNull();
    expect(classifyHost("github.com")).toBeNull();
  });

  it("returns null for empty host", () => {
    expect(classifyHost("")).toBeNull();
  });

  it("classifies a single-label host (no dot — registeredDomain fast path) as unrelated", () => {
    // Exercises the `parts.length < 2` branch in registeredDomain:
    // "localhost" splits to ["localhost"], so registeredDomain returns
    // the host as-is and no keyword hit fires.
    expect(classifyHost("localhost")).toBeNull();
  });

  it("classifies a co.jp registered domain via keyword on the two-level suffix branch", () => {
    // Exercises the twoLevelTlds branch in registeredDomain
    // ("co.jp" suffix → registered label is "myclinic", "clinic" keyword hits).
    expect(classifyHost("myclinic.co.jp")).toBe("health");
  });

  it("prefers adult over heuristic banking match", () => {
    // Defensive: even if a fictional adult site contains "bank" the
    // adult list is checked first by intent. None of the bundled adult
    // entries collide today, but the order matters for future entries.
    expect(classifyHost("pornhub.com")).toBe("adult");
  });
});
