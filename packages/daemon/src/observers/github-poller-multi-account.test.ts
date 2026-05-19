import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { EventBus } from "../core/event-bus.js";
import {
  GitHubPoller,
  type GhExecResult,
  type GhRunner,
  type RepoBinding,
} from "./github-poller.js";

/**
 * Phase 5 acceptance criterion: "Two repos with different `accountAlias`
 * values poll using different credentials in the same cycle without
 * `gh auth switch` being called."
 *
 * The proof shape:
 *   • Two `RepoBinding` rows, each with a distinct `accountAlias`.
 *   • An `accountResolver` returns a different `GH_TOKEN` per binding.
 *   • The mock runner records every call's `options.env`.
 *   • Assert: workflow_runs for repo-A ran with `GH_TOKEN=A`, repo-B with
 *     `GH_TOKEN=B`. The `["api","gh","auth","switch"]` arg sequence is
 *     never observed.
 */
describe("GitHubPoller — per-repo credential injection", () => {
  let db: Database.Database;
  let eventBus: EventBus;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    eventBus = new EventBus();
  });

  afterEach(() => {
    db.close();
  });

  it("scopes GH_TOKEN per workflow_runs call without invoking `gh auth switch`", async () => {
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: GhRunner = vi.fn(async (args, options) => {
      calls.push({ args, env: options?.env });
      // Stub responses depending on what the args ask for.
      if (args[0] === "api" && args[1].includes("notifications")) {
        return makeNotificationsOk("[]");
      }
      if (args[0] === "api" && args[1].endsWith("/repo-a") && args[2] === "--jq") {
        return { stdout: "main\n", stderr: "", exitCode: 0 };
      }
      if (args[0] === "api" && args[1].endsWith("/repo-b") && args[2] === "--jq") {
        return { stdout: "main\n", stderr: "", exitCode: 0 };
      }
      if (args[0] === "api" && args[1].includes("/repo-a/actions/runs")) {
        return { stdout: '{"workflow_runs":[]}', stderr: "", exitCode: 0 };
      }
      if (args[0] === "api" && args[1].includes("/repo-b/actions/runs")) {
        return { stdout: '{"workflow_runs":[]}', stderr: "", exitCode: 0 };
      }
      return { stdout: "{}", stderr: "", exitCode: 0 };
    });

    const accountResolver = vi.fn(async (binding: RepoBinding) => {
      if (binding.accountAlias === "work") {
        return { GH_TOKEN: "TOKEN_WORK", PA_GIT_TOKEN: "TOKEN_WORK" };
      }
      if (binding.accountAlias === "personal") {
        return { GH_TOKEN: "TOKEN_PERSONAL", PA_GIT_TOKEN: "TOKEN_PERSONAL" };
      }
      return undefined;
    });

    const poller = new GitHubPoller({
      db,
      eventBus,
      repoPaths: [],
      pollIntervalSeconds: 600,
      runner,
      accountResolver,
      repoBindings: [
        {
          owner: "acme",
          repo: "repo-a",
          fullName: "acme/repo-a",
          defaultBranch: "main",
          accountAlias: "work",
        },
        {
          owner: "acme",
          repo: "repo-b",
          fullName: "acme/repo-b",
          defaultBranch: "main",
          accountAlias: "personal",
        },
      ],
    });

    await poller.start();
    await poller.stop();

    const workflowCalls = calls.filter((c) =>
      c.args[1]?.includes("/actions/runs"),
    );
    expect(workflowCalls).toHaveLength(2);

    const repoACall = workflowCalls.find((c) =>
      c.args[1]?.includes("/repo-a/"),
    );
    const repoBCall = workflowCalls.find((c) =>
      c.args[1]?.includes("/repo-b/"),
    );
    expect(repoACall?.env?.GH_TOKEN).toBe("TOKEN_WORK");
    expect(repoBCall?.env?.GH_TOKEN).toBe("TOKEN_PERSONAL");

    // Notifications never gets a per-account env — global owner inbox.
    const notifCall = calls.find((c) => c.args[1] === "notifications");
    expect(notifCall?.env).toBeUndefined();

    // `gh auth switch` is never called.
    const switchCalls = calls.filter(
      (c) =>
        c.args[0] === "auth"
        || (c.args[0] === "api" && c.args.includes("switch")),
    );
    expect(switchCalls).toHaveLength(0);

    // The accountResolver was consulted exactly once per repo (the
    // workflow_runs poll). `repoBindings` bypasses the default-branch
    // lookup; that path is exercised by the dedicated test below.
    expect(accountResolver).toHaveBeenCalledTimes(2);
  });

  it("propagates the alias env to the default-branch lookup before the binding is built", async () => {
    // Critical for private repos: `fetchDefaultBranch` runs `gh api
    // repos/<o>/<r>` during `resolveRepoBindings`, BEFORE the binding's
    // `defaultBranch` field is filled. Without per-account env that call
    // 404s on private repos, falls back to "main", and freezes the wrong
    // default-branch onto the binding for the lifetime of the poller —
    // breaking `git.merge_to_default` classification permanently.
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: GhRunner = vi.fn(async (args, options) => {
      calls.push({ args, env: options?.env });
      if (args[0] === "api" && args[1].includes("notifications")) {
        return makeNotificationsOk("[]");
      }
      if (args[0] === "api" && /^repos\/[^/]+\/[^/]+$/.test(args[1])) {
        return { stdout: "develop\n", stderr: "", exitCode: 0 };
      }
      if (args[0] === "api" && args[1].includes("/actions/runs")) {
        return { stdout: '{"workflow_runs":[]}', stderr: "", exitCode: 0 };
      }
      return { stdout: "{}", stderr: "", exitCode: 0 };
    });

    const accountResolver = vi.fn(async (binding: { accountAlias?: string }) => {
      if (binding.accountAlias === "work") {
        return { GH_TOKEN: "TOKEN_WORK", PA_GIT_TOKEN: "TOKEN_WORK" };
      }
      return undefined;
    });

    const poller = new GitHubPoller({
      db,
      eventBus,
      repoPaths: [],
      // Use repoFullNames so resolveRepoBindings runs (the real path that
      // calls fetchDefaultBranch). repoBindings would bypass it.
      repoFullNames: ["acme/private-repo"],
      pollIntervalSeconds: 600,
      runner,
      accountResolver,
      repoAccountAliasResolver: ({ fullName }) =>
        fullName === "acme/private-repo" ? "work" : undefined,
    });

    await poller.start();
    await poller.stop();

    const defaultBranchCall = calls.find(
      (c) =>
        c.args[0] === "api"
        && c.args[1] === "repos/acme/private-repo"
        && c.args[2] === "--jq",
    );
    expect(defaultBranchCall).toBeDefined();
    expect(defaultBranchCall?.env?.GH_TOKEN).toBe("TOKEN_WORK");
  });

  it("skips env injection for repos without an accountAlias", async () => {
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: GhRunner = vi.fn(async (args, options) => {
      calls.push({ args, env: options?.env });
      if (args[0] === "api" && args[1].includes("notifications")) {
        return makeNotificationsOk("[]");
      }
      return { stdout: '{"workflow_runs":[]}', stderr: "", exitCode: 0 };
    });
    const accountResolver = vi.fn();

    const poller = new GitHubPoller({
      db,
      eventBus,
      repoPaths: [],
      pollIntervalSeconds: 600,
      runner,
      accountResolver: accountResolver as unknown as Parameters<
        typeof GitHubPoller
      >[0]["accountResolver"],
      repoBindings: [
        {
          owner: "acme",
          repo: "lonely",
          fullName: "acme/lonely",
          defaultBranch: "main",
        },
      ],
    });
    await poller.start();
    await poller.stop();

    expect(accountResolver).not.toHaveBeenCalled();
    const workflowCall = calls.find((c) =>
      c.args[1]?.includes("/actions/runs"),
    );
    expect(workflowCall?.env).toBeUndefined();
  });

  it("falls back to default env when the resolver throws", async () => {
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: GhRunner = vi.fn(async (args, options) => {
      calls.push({ args, env: options?.env });
      if (args[0] === "api" && args[1].includes("notifications")) {
        return makeNotificationsOk("[]");
      }
      return { stdout: '{"workflow_runs":[]}', stderr: "", exitCode: 0 };
    });

    const poller = new GitHubPoller({
      db,
      eventBus,
      repoPaths: [],
      pollIntervalSeconds: 600,
      runner,
      accountResolver: async () => {
        throw new Error("alias missing");
      },
      repoBindings: [
        {
          owner: "acme",
          repo: "boom",
          fullName: "acme/boom",
          defaultBranch: "main",
          accountAlias: "missing",
        },
      ],
    });
    await poller.start();
    await poller.stop();

    const workflowCall = calls.find((c) =>
      c.args[1]?.includes("/actions/runs"),
    );
    expect(workflowCall?.env).toBeUndefined();
  });
});

function makeNotificationsOk(body: string): GhExecResult {
  return {
    stdout: ["HTTP/2.0 200 OK", 'Etag: W/"x"', "", body].join("\n"),
    stderr: "",
    exitCode: 0,
  };
}
