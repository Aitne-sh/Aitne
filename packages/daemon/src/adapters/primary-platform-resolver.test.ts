import { describe, expect, it } from "vitest";
import {
  resolvePrimaryPlatform,
  type PrimaryPlatformResolverInput,
} from "./primary-platform-resolver.js";

function input(
  overrides: Partial<PrimaryPlatformResolverInput> = {},
): PrimaryPlatformResolverInput {
  return {
    configuredPrimary: "slack",
    primaryAdapterRegistered: false,
    registeredPlatforms: ["dashboard", "telegram"],
    effectiveFallback: "telegram",
    userExplicitlySetPrimary: false,
    ...overrides,
  };
}

describe("resolvePrimaryPlatform", () => {
  it("keeps the configured primary when its adapter is registered", () => {
    expect(
      resolvePrimaryPlatform(
        input({
          primaryAdapterRegistered: true,
          configuredPrimary: "telegram",
        }),
      ),
    ).toEqual({ kind: "keep" });
  });

  it("keeps when no adapter is registered at all (silent boot)", () => {
    expect(
      resolvePrimaryPlatform(
        input({
          registeredPlatforms: [],
          effectiveFallback: null,
        }),
      ),
    ).toEqual({ kind: "keep" });
  });

  it("auto-resolves and persists when user never explicitly chose", () => {
    expect(resolvePrimaryPlatform(input())).toEqual({
      kind: "switch",
      newPrimary: "telegram",
      persist: true,
      reason: "auto-resolve",
    });
  });

  it("falls back in-memory only when user explicitly chose the missing primary", () => {
    expect(
      resolvePrimaryPlatform(
        input({ userExplicitlySetPrimary: true }),
      ),
    ).toEqual({
      kind: "switch",
      newPrimary: "telegram",
      persist: false,
      reason: "fallback-only",
    });
  });

  it("reports no-fallback when nothing eligible is registered", () => {
    expect(
      resolvePrimaryPlatform(
        input({
          registeredPlatforms: ["dashboard"],
          effectiveFallback: null,
        }),
      ),
    ).toEqual({ kind: "no-fallback" });
  });

  it("forwards the caller-supplied fallback verbatim (does not decide order)", () => {
    // Order semantics ("first set up", canonical, etc.) are the
    // caller's responsibility — see selectFirstPairedPlatform in
    // messaging/owner-channels.ts. This test pins that the resolver is
    // purely a decision function over its inputs.
    const action = resolvePrimaryPlatform(
      input({
        registeredPlatforms: ["dashboard", "slack", "telegram", "discord"],
        effectiveFallback: "discord",
        configuredPrimary: "whatsapp",
      }),
    );
    expect(action).toEqual({
      kind: "switch",
      newPrimary: "discord",
      persist: true,
      reason: "auto-resolve",
    });
  });
});
