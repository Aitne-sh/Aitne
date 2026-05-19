import { describe, it, expect } from "vitest";
import { INTEGRATION_DESCRIPTORS } from "@aitne/shared";
import type { IntegrationListItem } from "@/lib/api-types";
import {
  buildToolPermissionsView,
  parseRawDenyList,
  toggleCapabilityDeny,
} from "./tool-permissions-card.logic";

function descriptor(key: "notion" | "gmail" | "google_calendar"): IntegrationListItem {
  const d = INTEGRATION_DESCRIPTORS[key];
  // Cast through the DTO shape — at runtime the descriptor is plain JSON.
  return {
    key: d.key,
    displayName: d.displayName,
    supportedModes: [...d.supportedModes],
    directSetup: d.directSetup
      ? {
          credentialKeys: [...d.directSetup.credentialKeys],
          helpUrl: d.directSetup.helpUrl,
        }
      : null,
    backendConnectors: Object.fromEntries(
      Object.entries(d.backendConnectors).map(([backend, connector]) => [
        backend,
        connector
          ? {
              toolNamespace: connector.toolNamespace,
              requiredCapabilities: [...connector.requiredCapabilities],
              optionalCapabilities: [...connector.optionalCapabilities],
              capabilityTools: Object.fromEntries(
                Object.entries(connector.capabilityTools).map(([k, v]) => [
                  k,
                  [...v],
                ]),
              ),
            }
          : undefined,
      ]),
    ),
    skillsTouched: [...d.skillsTouched],
    taskFlowsTouched: [...d.taskFlowsTouched],
    observersTouched: [...d.observersTouched],
    apiRoutesTouched: [...d.apiRoutesTouched],
    state: {
      mode: "delegated",
      delegatedBackend: "claude",
      lastChangedAt: "2026-04-25T00:00:00Z",
    },
  };
}

describe("buildToolPermissionsView", () => {
  it("returns null when no backend is provided", () => {
    expect(buildToolPermissionsView(descriptor("notion"), null, [])).toBeNull();
  });

  // The "no connector for backend" null-return branch is reserved for
  // future integrations that omit a backend from `backendConnectors`.
  // Today every (integrationKey, BackendId) pair has a connector.

  it("emits one row per optional capability with required-flag set on required ones", () => {
    const view = buildToolPermissionsView(
      descriptor("notion"),
      "claude",
      [],
    );
    expect(view).not.toBeNull();
    if (!view) return;
    // Notion's required set is search/read/create_page/update_properties/patch_content/archive.
    const search = view.rows.find((r) => r.capability === "search");
    expect(search?.required).toBe(true);
    const schema = view.rows.find((r) => r.capability === "schema_admin");
    expect(schema?.required).toBe(false);
    expect(schema?.tools).toEqual(
      expect.arrayContaining([
        "notion-create-database",
        "notion-update-data-source",
      ]),
    );
  });

  it("flags rows as denied when ALL tools in the capability are in deniedTools", () => {
    const view = buildToolPermissionsView(descriptor("notion"), "claude", [
      "notion-create-database",
      "notion-update-data-source",
      "notion-create-view",
      "notion-update-view",
    ]);
    expect(view).not.toBeNull();
    if (!view) return;
    const schema = view.rows.find((r) => r.capability === "schema_admin");
    expect(schema?.denied).toBe(true);
  });

  it("does NOT flag a row as denied when only some of its tools are denied", () => {
    const view = buildToolPermissionsView(descriptor("notion"), "claude", [
      "notion-create-database",
    ]);
    expect(view).not.toBeNull();
    if (!view) return;
    const schema = view.rows.find((r) => r.capability === "schema_admin");
    // Half-denied schema_admin (only one of four tools) reads as not-denied
    // — the toggle is per-capability, so partial-deny means "still on" in
    // the UI even though the underlying tool is gone. That's an honest
    // representation of the underlying mismatch and the dashboard surfaces
    // a tooltip showing which sub-tools are denied.
    expect(schema?.denied).toBe(false);
  });

  it("partitions stale entries (Claude name carried over to a Codex backend)", () => {
    const view = buildToolPermissionsView(descriptor("notion"), "codex", [
      "notion_create_database", // valid Codex name
      "notion-create-database", // Claude carryover — stale
      "fake-tool", // never existed
    ]);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.staleDeniedTools.sort()).toEqual([
      "fake-tool",
      "notion-create-database",
    ]);
  });

  it("marks the view as soft-enforcement on non-Claude backends", () => {
    const claude = buildToolPermissionsView(descriptor("notion"), "claude", []);
    const codex = buildToolPermissionsView(descriptor("notion"), "codex", []);
    expect(claude?.softEnforcement).toBe(false);
    expect(codex?.softEnforcement).toBe(true);
  });

  it("Gmail Claude: shows draft-only required set and lacks send/delete rows (descriptor-driven)", () => {
    const view = buildToolPermissionsView(descriptor("gmail"), "claude", []);
    expect(view).not.toBeNull();
    if (!view) return;
    const caps = view.rows.map((r) => r.capability);
    expect(caps).toContain("search");
    expect(caps).toContain("draft");
    expect(caps).toContain("label");
    // Claude's Gmail connector doesn't list send/delete in optional;
    // those rows shouldn't render.
    expect(caps).not.toContain("send");
    expect(caps).not.toContain("delete");
  });
});

describe("toggleCapabilityDeny", () => {
  const view = buildToolPermissionsView(descriptor("notion"), "claude", [])!;
  const schemaRow = view.rows.find((r) => r.capability === "schema_admin")!;

  it("denies every tool for a capability when toggled on", () => {
    const next = toggleCapabilityDeny([], schemaRow, true);
    expect(next.sort()).toEqual(
      ["notion-create-database", "notion-create-view", "notion-update-data-source", "notion-update-view"].sort(),
    );
  });

  it("removes every tool for a capability when toggled off", () => {
    const next = toggleCapabilityDeny(
      ["notion-create-database", "notion-update-view", "unrelated-tool"],
      schemaRow,
      false,
    );
    expect(next).toEqual(["unrelated-tool"]);
  });

  it("preserves entries for OTHER capabilities and stale entries on toggle", () => {
    const next = toggleCapabilityDeny(
      ["unrelated-tool", "notion-create-comment"],
      schemaRow,
      true,
    );
    expect(next).toContain("unrelated-tool");
    expect(next).toContain("notion-create-comment");
    expect(next).toContain("notion-create-database");
  });
});

describe("parseRawDenyList (DELEGATED-MODE-V2 §7.1 raw editor)", () => {
  it("returns an empty array for empty input", () => {
    expect(parseRawDenyList("")).toEqual([]);
    expect(parseRawDenyList("   \n\n   \n")).toEqual([]);
  });

  it("trims each line and skips empties", () => {
    expect(parseRawDenyList("  send_email  \n\n   delete_emails  \n"))
      .toEqual(["send_email", "delete_emails"]);
  });

  it("preserves user ordering and dedups (first occurrence wins)", () => {
    expect(parseRawDenyList("send_email\ndelete_emails\nsend_email"))
      .toEqual(["send_email", "delete_emails"]);
  });

  it("accepts CRLF line endings without dropping or doubling entries", () => {
    expect(parseRawDenyList("send_email\r\ndelete_emails\r\n"))
      .toEqual(["send_email", "delete_emails"]);
  });

  it("flows glob-style entries through verbatim — server validates", () => {
    expect(parseRawDenyList("delete_*\nsend_email"))
      .toEqual(["delete_*", "send_email"]);
  });
});
