import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { createRepository, createTrigger } from "../db/repositories-store.js";
import { createGitHubRoutes, verifySignature } from "./routes/github.js";

/**
 * Seed a repository row matching `<owner>/<repo>` so the unified webhook
 * resolver lets the event through. Tests written before the cutover passed
 * `config.gitRepos` and expected the webhook to fall through to silent
 * name-matching; the unified resolver requires an explicit row.
 */
function seedRepoRow(
  db: Database.Database,
  fullName: string,
  options: { localPath?: string } = {},
): void {
  const parts = fullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (typeof owner !== "string" || owner.length === 0) return;
  if (typeof repo !== "string" || repo.length === 0) return;
  createRepository(db, {
    githubOwner: owner,
    githubRepo: repo,
    localPath: options.localPath ?? null,
  });
}
import type { AgentConfig } from "../config.js";
import { SecretBroker } from "../secrets/secret-broker.js";
import type { SecretStore } from "../secrets/secret-store.js";
import type { StoredSecretName } from "../secrets/secret-names.js";

class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<StoredSecretName, string>();

  constructor(seed: Partial<Record<StoredSecretName, string>> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      if (typeof value === "string") {
        this.values.set(key as StoredSecretName, value);
      }
    }
  }

  async has(name: StoredSecretName): Promise<boolean> {
    return this.values.has(name);
  }

  async get(name: StoredSecretName): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: StoredSecretName, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: StoredSecretName): Promise<void> {
    this.values.delete(name);
  }
}

describe("GitHub webhook signature verification", () => {
  const secret = "test-webhook-secret";

  function sign(payload: string): string {
    return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  }

  it("accepts valid signature", () => {
    const payload = '{"action":"push"}';
    const signature = sign(payload);
    expect(verifySignature(payload, signature, secret)).toBe(true);
  });

  it("rejects invalid signature", () => {
    const payload = '{"action":"push"}';
    const badSig = "sha256=0000000000000000000000000000000000000000000000000000000000000000";
    expect(verifySignature(payload, badSig, secret)).toBe(false);
  });

  it("rejects tampered payload", () => {
    const payload = '{"action":"push"}';
    const signature = sign(payload);
    const tampered = '{"action":"delete"}';
    expect(verifySignature(tampered, signature, secret)).toBe(false);
  });

  it("rejects wrong-length signature", () => {
    const payload = '{"action":"push"}';
    expect(verifySignature(payload, "sha256=short", secret)).toBe(false);
  });

  it("handles empty payload", () => {
    const payload = "";
    const signature = sign(payload);
    expect(verifySignature(payload, signature, secret)).toBe(true);
  });
});

describe("GitHub route creation", () => {
  it("module exports createGitHubRoutes", async () => {
    const mod = await import("./routes/github.js");
    expect(mod.createGitHubRoutes).toBeDefined();
    expect(typeof mod.createGitHubRoutes).toBe("function");
  });
});

describe("GitHub API proxy routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("GET /github/repos returns 503 when token not configured", async () => {
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({}),
      { cacheTtlMs: 0 },
    );
    const { apiApp } = createGitHubRoutes({
      db,
      config: { gitRepos: ["/tmp/my-project"] } as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
    });

    const res = await apiApp.request("/github/repos");
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("github_not_configured");
  });

  it("GET /github/pulls returns 503 when token not configured", async () => {
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({}),
      { cacheTtlMs: 0 },
    );
    const { apiApp } = createGitHubRoutes({
      db,
      config: { gitRepos: [] } as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
    });

    const res = await apiApp.request("/github/pulls?owner=test-owner&repo=test");
    expect(res.status).toBe(503);
  });

  it("GET /github/pulls returns 400 when owner/repo missing", async () => {
    // Mock Octokit availability
    vi.doMock("@octokit/rest", () => ({
      Octokit: class MockOctokit {
        pulls = { list: vi.fn() };
        issues = { createComment: vi.fn() };
      },
    }));
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubToken: "ghp_test" }),
      { cacheTtlMs: 0 },
    );
    const { apiApp } = createGitHubRoutes({
      db,
      config: { gitRepos: [] } as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
    });

    const res = await apiApp.request("/github/pulls");
    expect(res.status).toBe(400);
    vi.doUnmock("@octokit/rest");
  });

  it("GET /github/pulls resolves a GitHub slug through the unified repository store", async () => {
    const list = vi.fn().mockResolvedValue({ data: [] });
    vi.doMock("@octokit/rest", () => ({
      Octokit: class MockOctokit {
        pulls = { list };
        issues = { createComment: vi.fn() };
      },
    }));
    seedRepoRow(db, "test-owner/aitne");
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubToken: "ghp_test" }),
      { cacheTtlMs: 0 },
    );
    const { apiApp } = createGitHubRoutes({
      db,
      config: { gitRepos: [] } as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
    });

    const res = await apiApp.request(
      "/github/pulls?repo=test-owner%2Faitne&state=all",
    );
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "aitne",
      state: "all",
      per_page: 30,
    });
    vi.doUnmock("@octokit/rest");
  });

  it("POST /github/pulls/comment returns 503 when token not configured", async () => {
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({}),
      { cacheTtlMs: 0 },
    );
    const { apiApp } = createGitHubRoutes({
      db,
      config: { gitRepos: [] } as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
    });

    const res = await apiApp.request("/github/pulls/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: "test-owner",
        repo: "test",
        pull_number: 1,
        comment: "LGTM",
      }),
    });
    expect(res.status).toBe(503);
  });

  it("POST /github/pulls/comment returns 400 when fields missing", async () => {
    vi.doMock("@octokit/rest", () => ({
      Octokit: class MockOctokit {
        pulls = { list: vi.fn() };
        issues = { createComment: vi.fn() };
      },
    }));
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubToken: "ghp_test" }),
      { cacheTtlMs: 0 },
    );
    const { apiApp } = createGitHubRoutes({
      db,
      config: { gitRepos: [] } as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
    });

    const res = await apiApp.request("/github/pulls/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "test-owner" }),
    });
    expect(res.status).toBe(400);
    vi.doUnmock("@octokit/rest");
  });

  it("POST /github/pulls/comment resolves repositoryId before commenting", async () => {
    const createComment = vi.fn().mockResolvedValue({
      data: { id: 123, html_url: "https://github.com/test-owner/aitne/pull/1#issuecomment-123" },
    });
    vi.doMock("@octokit/rest", () => ({
      Octokit: class MockOctokit {
        pulls = { list: vi.fn() };
        issues = { createComment };
      },
    }));
    const row = createRepository(db, {
      githubOwner: "test-owner",
      githubRepo: "personal_agent",
    });
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubToken: "ghp_test" }),
      { cacheTtlMs: 0 },
    );
    const { apiApp } = createGitHubRoutes({
      db,
      config: { gitRepos: [] } as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
    });

    const res = await apiApp.request("/github/pulls/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryId: row.id,
        pull_number: 1,
        comment: "LGTM",
      }),
    });
    expect(res.status).toBe(200);
    expect(createComment).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "personal_agent",
      issue_number: 1,
      body: "LGTM",
    });
    vi.doUnmock("@octokit/rest");
  });
});

describe("GitHub webhook push handling", () => {
  const secret = "test-webhook-secret";
  let db: Database.Database;

  function sign(payload: string): string {
    return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("records pushes as observations instead of queueing reactive events", async () => {
    const eventBus = {
      put: vi.fn().mockResolvedValue(undefined),
    };
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    seedRepoRow(db, "test-owner/aitne", { localPath: "/tmp/personal_agent" });
    const { webhookApp } = createGitHubRoutes({
      db,
      config: {} as unknown as AgentConfig,
      secretBroker,
      eventBus: eventBus as never,
    });

    const payload = {
      ref: "refs/heads/main",
      before: "1111111111111111111111111111111111111111",
      after: "2222222222222222222222222222222222222222",
      repository: {
        full_name: "test-owner/aitne",
      },
      pusher: {
        name: "test-owner",
      },
      commits: [
        {
          id: "2222222222222222222222222222222222222222",
          message: "Phase 9 fix",
          author: { name: "test-owner" },
          added: ["packages/daemon/src/api/routes/github.ts"],
          modified: ["packages/daemon/src/index.ts"],
          removed: [],
        },
      ],
    };
    const raw = JSON.stringify(payload);

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(res.status).toBe(200);
    expect(eventBus.put).not.toHaveBeenCalled();

    const rows = db.prepare(
      "SELECT source, ref, change_type, actor, payload FROM observations",
    ).all() as Array<{
      source: string;
      ref: string;
      change_type: string;
      actor: string;
      payload: string | null;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "git:/tmp/personal_agent",
      ref: "2222222222222222222222222222222222222222",
      change_type: "modified",
      actor: "user",
    });

    const storedPayload = JSON.parse(rows[0].payload ?? "{}") as {
      repoPath?: string;
      repository?: string;
      commitCount?: number;
      changedFiles?: string[];
      previousHash?: string;
    };
    expect(storedPayload.repoPath).toBe("/tmp/personal_agent");
    expect(storedPayload.repository).toBe("test-owner/aitne");
    expect(storedPayload.commitCount).toBe(1);
    expect(storedPayload.previousHash).toBe(
      "1111111111111111111111111111111111111111",
    );
    expect(storedPayload.changedFiles).toEqual([
      "packages/daemon/src/api/routes/github.ts",
      "packages/daemon/src/index.ts",
    ]);
  });

  it("returns 503 when webhook secret is not configured", async () => {
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({}),
      { cacheTtlMs: 0 },
    );
    const { webhookApp } = createGitHubRoutes({
      db,
      config: { gitRepos: [] } as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
    });

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=dummy",
      },
      body: "{}",
    });

    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("webhook_not_configured");
  });

  it("returns 401 when signature is missing", async () => {
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    const { webhookApp } = createGitHubRoutes({
      db,
      config: { gitRepos: [] } as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
    });

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
      },
      body: "{}",
    });

    expect(res.status).toBe(401);
  });

  it("returns 400 when event type header is missing", async () => {
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    const { webhookApp } = createGitHubRoutes({
      db,
      config: { gitRepos: [] } as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
    });

    const raw = "{}";
    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("missing_event_type");
  });

  it("returns 400 for invalid JSON body", async () => {
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    const { webhookApp } = createGitHubRoutes({
      db,
      config: { gitRepos: [] } as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
    });

    const raw = "not json";
    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  it("emits events for pull_request webhook", async () => {
    const eventBus = { put: vi.fn().mockResolvedValue(undefined) };
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    seedRepoRow(db, "test-owner/test-repo");
    const { webhookApp } = createGitHubRoutes({
      db,
      config: {} as unknown as AgentConfig,
      secretBroker,
      eventBus: eventBus as never,
    });

    const payload = {
      action: "opened",
      repository: { full_name: "test-owner/test-repo" },
      pull_request: {
        number: 42,
        title: "Fix bug",
        user: { login: "test-owner" },
        html_url: "https://github.com/test-owner/test-repo/pull/42",
        draft: false,
      },
    };
    const raw = JSON.stringify(payload);

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(res.status).toBe(200);
    expect(eventBus.put).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "github.pull_request.opened",
      }),
    );
  });

  it("dispatches matching repository triggers for webhook events", async () => {
    // `github.pull_request.opened|synchronize|closed` are produced ONLY by
    // the webhook — without the dispatch hook a trigger on those event
    // types could never fire (the trigger editor offers them).
    const eventBus = { put: vi.fn().mockResolvedValue(undefined) };
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    seedRepoRow(db, "test-owner/test-repo");
    createTrigger(
      db,
      "github:test-owner/test-repo",
      {
        name: "on-pr-open",
        eventType: "github.pull_request.opened",
        filters: { action: "opened" },
        backend: "claude",
        model: "sonnet",
        workdirMode: "temp",
        prompt: "triage the new PR",
        instructionMd: "# temp instructions",
      },
      { validateModel: () => true },
    );
    const { webhookApp } = createGitHubRoutes({
      db,
      config: {} as unknown as AgentConfig,
      secretBroker,
      eventBus: eventBus as never,
    });

    const payload = {
      action: "opened",
      repository: { full_name: "test-owner/test-repo" },
      pull_request: {
        number: 7,
        title: "Add feature",
        user: { login: "someone" },
        html_url: "https://github.com/test-owner/test-repo/pull/7",
        draft: false,
      },
    };
    const raw = JSON.stringify(payload);

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(res.status).toBe(200);
    // Task-flow pipeline event…
    expect(eventBus.put).toHaveBeenCalledWith(
      expect.objectContaining({ type: "github.pull_request.opened" }),
    );
    // …plus the trigger-fired scheduled.task riding alongside it.
    expect(eventBus.put).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "scheduled.task",
        taskContext: expect.objectContaining({
          triggerSource: "repository_trigger",
          triggerEventType: "github.pull_request.opened",
          workdirMode: "temp",
          prompt: "triage the new PR",
        }),
      }),
    );
  });

  it("does not dispatch triggers whose filters do not match the webhook payload", async () => {
    const eventBus = { put: vi.fn().mockResolvedValue(undefined) };
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    seedRepoRow(db, "test-owner/test-repo");
    createTrigger(
      db,
      "github:test-owner/test-repo",
      {
        name: "on-pr-close-only",
        eventType: "github.pull_request.opened",
        filters: { action: "closed" },
        backend: "claude",
        model: "sonnet",
        workdirMode: "temp",
        prompt: "never fires",
        instructionMd: "# temp instructions",
      },
      { validateModel: () => true },
    );
    const { webhookApp } = createGitHubRoutes({
      db,
      config: {} as unknown as AgentConfig,
      secretBroker,
      eventBus: eventBus as never,
    });

    const payload = {
      action: "opened",
      repository: { full_name: "test-owner/test-repo" },
      pull_request: { number: 8, title: "x", user: { login: "u" }, html_url: "", draft: false },
    };
    const raw = JSON.stringify(payload);

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(res.status).toBe(200);
    expect(eventBus.put).toHaveBeenCalledTimes(1);
    expect(eventBus.put).toHaveBeenCalledWith(
      expect.objectContaining({ type: "github.pull_request.opened" }),
    );
  });

  it("surfaces an EventBus.put rejection instead of dropping it", async () => {
    // The webhook handler awaits `eventBus.put`. A rejected enqueue must
    // propagate to Hono's error handler (500) rather than be swallowed as an
    // unhandled promise rejection while the handler still returns 200
    // `accepted`. This pins the await fix in github.ts.
    const eventBus = {
      put: vi.fn().mockRejectedValue(new Error("event queue saturated")),
    };
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    seedRepoRow(db, "test-owner/test-repo");
    const { webhookApp } = createGitHubRoutes({
      db,
      config: {} as unknown as AgentConfig,
      secretBroker,
      eventBus: eventBus as never,
    });

    const payload = {
      action: "opened",
      repository: { full_name: "test-owner/test-repo" },
      pull_request: {
        number: 7,
        title: "Surface enqueue failures",
        user: { login: "test-owner" },
        html_url: "https://github.com/test-owner/test-repo/pull/7",
        draft: false,
      },
    };
    const raw = JSON.stringify(payload);

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(eventBus.put).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
  });

  it("emits events for issues webhook", async () => {
    const eventBus = { put: vi.fn().mockResolvedValue(undefined) };
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    seedRepoRow(db, "test-owner/test-repo");
    const { webhookApp } = createGitHubRoutes({
      db,
      config: {} as unknown as AgentConfig,
      secretBroker,
      eventBus: eventBus as never,
    });

    const payload = {
      action: "opened",
      repository: { full_name: "test-owner/test-repo" },
      issue: {
        number: 10,
        title: "New issue",
        user: { login: "test-owner" },
        html_url: "https://github.com/test-owner/test-repo/issues/10",
      },
    };
    const raw = JSON.stringify(payload);

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(res.status).toBe(200);
    expect(eventBus.put).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "github.issue.opened",
      }),
    );
  });

  it("emits events for release webhook", async () => {
    const eventBus = { put: vi.fn().mockResolvedValue(undefined) };
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    seedRepoRow(db, "test-owner/test-repo");
    const { webhookApp } = createGitHubRoutes({
      db,
      config: {} as unknown as AgentConfig,
      secretBroker,
      eventBus: eventBus as never,
    });

    const payload = {
      action: "published",
      repository: { full_name: "test-owner/test-repo" },
      release: {
        tag_name: "v1.0.0",
        name: "Release 1.0",
        html_url: "https://github.com/test-owner/test-repo/releases/tag/v1.0.0",
        prerelease: false,
      },
    };
    const raw = JSON.stringify(payload);

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "release",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(res.status).toBe(200);
    expect(eventBus.put).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "github.release.published",
      }),
    );
  });

  it("emits events for workflow_run completed with failure", async () => {
    const eventBus = { put: vi.fn().mockResolvedValue(undefined) };
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    seedRepoRow(db, "test-owner/test-repo");
    const { webhookApp } = createGitHubRoutes({
      db,
      config: {} as unknown as AgentConfig,
      secretBroker,
      eventBus: eventBus as never,
    });

    const payload = {
      action: "completed",
      repository: { full_name: "test-owner/test-repo" },
      workflow_run: {
        name: "CI",
        conclusion: "failure",
        html_url: "https://github.com/test-owner/test-repo/actions/runs/1",
        head_branch: "main",
      },
    };
    const raw = JSON.stringify(payload);

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(res.status).toBe(200);
    expect(eventBus.put).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "github.workflow_run.completed",
      }),
    );
  });

  it("skips workflow_run events that are not completed", async () => {
    const eventBus = { put: vi.fn().mockResolvedValue(undefined) };
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    seedRepoRow(db, "test-owner/test-repo");
    const { webhookApp } = createGitHubRoutes({
      db,
      config: {} as unknown as AgentConfig,
      secretBroker,
      eventBus: eventBus as never,
    });

    const payload = {
      action: "requested",
      repository: { full_name: "test-owner/test-repo" },
      workflow_run: {
        name: "CI",
        conclusion: null,
        html_url: "https://github.com/test-owner/test-repo/actions/runs/2",
        head_branch: "main",
      },
    };
    const raw = JSON.stringify(payload);

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(res.status).toBe(200);
    // Should NOT emit an event
    expect(eventBus.put).not.toHaveBeenCalled();
  });

  it("ignores unhandled event types without error", async () => {
    const eventBus = { put: vi.fn().mockResolvedValue(undefined) };
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    seedRepoRow(db, "test-owner/test-repo");
    const { webhookApp } = createGitHubRoutes({
      db,
      config: {} as unknown as AgentConfig,
      secretBroker,
      eventBus: eventBus as never,
    });

    const payload = {
      action: "created",
      repository: { full_name: "test-owner/test-repo" },
    };
    const raw = JSON.stringify(payload);

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "star",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(res.status).toBe(200);
    expect(eventBus.put).not.toHaveBeenCalled();
  });

  it("calls onWebhookEvent callback when provided", async () => {
    const onWebhookEvent = vi.fn();
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    seedRepoRow(db, "test/repo");
    const { webhookApp } = createGitHubRoutes({
      db,
      config: {} as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
      onWebhookEvent,
    });

    const payload = { action: "created", repository: { full_name: "test/repo" } };
    const raw = JSON.stringify(payload);

    await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "star",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(onWebhookEvent).toHaveBeenCalled();
  });

  it("drops webhooks whose repo is not in the unified table", async () => {
    // Post-cutover the webhook resolves owner/repo against the unified
    // `repositories` table; an unknown repo is dropped with an
    // `agent_actions(action_type='dropped_unknown_repo')` row instead of
    // falling through to a name-only match. See
    // docs/design/appendices/unified-repositories.md §4.2.
    const secretBroker = new SecretBroker(
      new InMemorySecretStore({ githubWebhookSecret: secret }),
      { cacheTtlMs: 0 },
    );
    // Seed a different row so the table isn't empty (defense against a
    // future "drop only when DB is empty" regression).
    seedRepoRow(db, "test-owner/other-repo", { localPath: "/tmp/other_repo" });
    const { webhookApp } = createGitHubRoutes({
      db,
      config: {} as unknown as AgentConfig,
      secretBroker,
      eventBus: { put: vi.fn() } as never,
    });

    const payload = {
      ref: "refs/heads/main",
      before: "aaaa",
      after: "bbbb",
      repository: { full_name: "test-owner/aitne" },
      pusher: { name: "test-owner" },
      commits: [{ id: "bbbb", message: "test", author: { name: "test-owner" }, added: [], modified: ["file.ts"], removed: [] }],
    };
    const raw = JSON.stringify(payload);

    const res = await webhookApp.request("/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });

    expect(res.status).toBe(200);
    const rows = db
      .prepare("SELECT source FROM observations")
      .all() as Array<{ source: string }>;
    expect(rows).toHaveLength(0);

    const audit = db
      .prepare(
        "SELECT action_type FROM agent_actions WHERE action_type = 'dropped_unknown_repo'",
      )
      .all();
    expect(audit).toHaveLength(1);
  });
});
