/**
 * docs/design/appendices/opencode-backend.md §6.4 — Phase 2 manager tests. Drives the
 * managed lifecycle through a mocked `createOpencode` so the suite
 * remains hermetic (no real opencode child process). Verifies:
 *
 *   - canonical hash is order-independent + ignores `undefined`
 *   - same-hash ensureConfig is a no-op (no bounce)
 *   - different-hash ensureConfig fires a bounce
 *   - shutdown is idempotent
 *   - shutdown after construction without spawn is harmless
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import {
  hashRuntimeConfig,
  ManagedOpencodeServerManager,
} from "./opencode-server-manager.js";

type CreateOpencodeFn = typeof createOpencode;

interface FakeRun {
  closes: number;
  url: string;
  configReceived: unknown;
}

function makeCreateOpencodeStub(): {
  impl: CreateOpencodeFn;
  runs: FakeRun[];
  resetClose: () => void;
} {
  const runs: FakeRun[] = [];
  const impl: CreateOpencodeFn = (async (options?: Parameters<CreateOpencodeFn>[0]) => {
    const run: FakeRun = {
      closes: 0,
      url: `http://127.0.0.1:${10_000 + runs.length}`,
      configReceived: options?.config,
    };
    runs.push(run);
    const client = {
      // Minimal stub — only `session.delete` is exercised by the manager
      // unit tests; the broader API is exercised by OpencodeCore tests.
      session: { delete: async () => ({}) },
    } as unknown as OpencodeClient;
    const server = {
      url: run.url,
      close: () => {
        run.closes += 1;
      },
    };
    return { client, server };
  }) as CreateOpencodeFn;
  return {
    impl,
    runs,
    resetClose: () => {
      for (const run of runs) run.closes = 0;
    },
  };
}

describe("hashRuntimeConfig", () => {
  it("is stable across key ordering", () => {
    const a = hashRuntimeConfig({
      model: "anthropic/claude-sonnet-4-6",
      tools: { task: false },
    });
    const b = hashRuntimeConfig({
      tools: { task: false },
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(a).toBe(b);
  });

  it("treats undefined fields as absent", () => {
    expect(hashRuntimeConfig({ model: "x/y" })).toBe(
      hashRuntimeConfig({ model: "x/y", small_model: undefined }),
    );
  });

  it("differs when the model changes", () => {
    expect(hashRuntimeConfig({ model: "x/y" })).not.toBe(
      hashRuntimeConfig({ model: "x/z" }),
    );
  });

  it("does not collapse different permission rules", () => {
    expect(
      hashRuntimeConfig({ permission: { bash: "deny" } }),
    ).not.toBe(hashRuntimeConfig({ permission: { bash: "allow" } }));
  });
});

describe("ManagedOpencodeServerManager", () => {
  let manager: ManagedOpencodeServerManager | null = null;

  afterEach(async () => {
    await manager?.shutdown();
    manager = null;
  });

  it("spawns lazily on the first client() call when no ensureConfig ran", async () => {
    const stub = makeCreateOpencodeStub();
    manager = new ManagedOpencodeServerManager({
      createOpencodeImpl: stub.impl,
    });
    expect(manager.isRunning).toBe(false);
    const client = await manager.client();
    expect(client).toBeDefined();
    expect(manager.isRunning).toBe(true);
    expect(stub.runs).toHaveLength(1);
  });

  it("ensureConfig is a no-op when the desired hash already matches", async () => {
    const stub = makeCreateOpencodeStub();
    manager = new ManagedOpencodeServerManager({
      createOpencodeImpl: stub.impl,
    });
    await manager.ensureConfig({ model: "anthropic/claude-haiku-4-5" });
    const hashAfterFirst = manager.currentHash;
    expect(stub.runs).toHaveLength(1);

    await manager.ensureConfig({ model: "anthropic/claude-haiku-4-5" });
    expect(manager.currentHash).toBe(hashAfterFirst);
    expect(stub.runs).toHaveLength(1); // no bounce
    // No close happened.
    expect(stub.runs[0]?.closes).toBe(0);
  });

  it("bounces when the desired config differs (close + respawn)", async () => {
    const stub = makeCreateOpencodeStub();
    manager = new ManagedOpencodeServerManager({
      createOpencodeImpl: stub.impl,
    });
    await manager.ensureConfig({ model: "anthropic/claude-haiku-4-5" });
    await manager.ensureConfig({ model: "anthropic/claude-sonnet-4-6" });
    expect(stub.runs).toHaveLength(2);
    expect(stub.runs[0]?.closes).toBe(1);
    expect(stub.runs[1]?.closes).toBe(0);
  });

  it("threads the desired config into createOpencode", async () => {
    const stub = makeCreateOpencodeStub();
    manager = new ManagedOpencodeServerManager({
      createOpencodeImpl: stub.impl,
    });
    await manager.ensureConfig({
      model: "anthropic/claude-sonnet-4-6",
      tools: { task: false },
    });
    expect(stub.runs[0]?.configReceived).toMatchObject({
      model: "anthropic/claude-sonnet-4-6",
      tools: { task: false },
    });
  });

  it("shutdown closes the running child and refuses further work", async () => {
    const stub = makeCreateOpencodeStub();
    manager = new ManagedOpencodeServerManager({
      createOpencodeImpl: stub.impl,
    });
    await manager.client();
    expect(stub.runs[0]?.closes).toBe(0);
    await manager.shutdown();
    expect(stub.runs[0]?.closes).toBe(1);
    await expect(manager.client()).rejects.toThrow(/shut down/);
    await expect(
      manager.ensureConfig({ model: "x/y" }),
    ).rejects.toThrow(/shut down/);
  });

  it("shutdown is safe on a manager that never spawned", async () => {
    const stub = makeCreateOpencodeStub();
    const m = new ManagedOpencodeServerManager({
      createOpencodeImpl: stub.impl,
    });
    await m.shutdown();
    expect(stub.runs).toHaveLength(0);
  });

  it("coalesces concurrent client() callers onto a single spawn", async () => {
    let resolveSpawn!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveSpawn = resolve;
    });
    const stub = makeCreateOpencodeStub();
    const slowImpl: CreateOpencodeFn = (async (opts?: Parameters<CreateOpencodeFn>[0]) => {
      await gate;
      return stub.impl(opts);
    }) as CreateOpencodeFn;
    manager = new ManagedOpencodeServerManager({
      createOpencodeImpl: slowImpl,
    });
    const p1 = manager.client();
    const p2 = manager.client();
    resolveSpawn();
    await Promise.all([p1, p2]);
    expect(stub.runs).toHaveLength(1);
  });

  it("logs a warning but does not throw when server.close() throws during bounce", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const throwingImpl: CreateOpencodeFn = (async (
        opts?: Parameters<CreateOpencodeFn>[0],
      ) => {
        const port = Math.floor(Math.random() * 30_000) + 10_000;
        return {
          client: { session: { delete: async () => ({}) } } as unknown as OpencodeClient,
          server: {
            url: `http://127.0.0.1:${port}`,
            close: () => {
              throw new Error("synthetic close failure");
            },
          },
          _opts: opts,
        };
      }) as unknown as CreateOpencodeFn;
      manager = new ManagedOpencodeServerManager({
        createOpencodeImpl: throwingImpl,
      });
      await manager.ensureConfig({ model: "x/a" });
      // Bounce — second spawn must succeed despite first close throwing.
      await expect(
        manager.ensureConfig({ model: "x/b" }),
      ).resolves.toBeUndefined();
      expect(manager.currentHash).toBe(
        hashRuntimeConfig({ model: "x/b" }),
      );
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
