import { describe, expect, it } from "vitest";
import { isWriteAllowed } from "./permissions.js";

// Paths reach isWriteAllowed with the `.md` extension already stripped
// (normalizeContextPath) — these cases use the whitelist form.
describe("isWriteAllowed — knowledge/sources (SOURCE_LIBRARY_DESIGN.md)", () => {
  it("allows PUT/PATCH on the sources index (DELETE rides the subtree wildcard — snapshotted + recreatable)", () => {
    expect(isWriteAllowed("knowledge/sources/_index", "PUT")).toBe(true);
    expect(isWriteAllowed("knowledge/sources/_index", "PATCH")).toBe(true);
    expect(isWriteAllowed("knowledge/sources/_index", "DELETE")).toBe(true);
  });

  it("allows PUT/PATCH/DELETE on flat and collection-nested cards", () => {
    for (const path of [
      "knowledge/sources/orphan-card",
      "knowledge/sources/acme-launch/pitch-deck",
      "knowledge/sources/acme-launch/sub/deep-card",
    ]) {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        expect(isWriteAllowed(path, method), `${method} ${path}`).toBe(true);
      }
    }
  });

  it("does not open the knowledge/ parent or its sibling subtrees", () => {
    expect(isWriteAllowed("knowledge/sources", "PUT")).toBe(false);
    expect(isWriteAllowed("knowledge/wiki/page", "PUT")).toBe(false);
    expect(isWriteAllowed("knowledge/repos/some-repo/overview", "DELETE")).toBe(
      false,
    );
    expect(isWriteAllowed("knowledge/dossiers/flow", "DELETE")).toBe(false);
  });
});
