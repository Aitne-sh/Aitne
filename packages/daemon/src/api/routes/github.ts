import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { EventPriority, createEvent } from "@aitne/shared";
import type { EventBus } from "../../core/event-bus.js";
import type { AgentConfig } from "../../config.js";
import { recordObservation, type RecordObservationParams } from "../../db/observations.js";
import {
  getRepositoryByGithub,
  resolveRepositoryIdentifier,
  selectGithubRepoSlugs,
  type RepositoryDTO,
} from "../../db/repositories-store.js";
import type { SecretBroker } from "../../secrets/secret-broker.js";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import { readJsonBody } from "../json-body.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const logger = createLogger("github-api");

type Octokit = InstanceType<Awaited<typeof import("@octokit/rest")>["Octokit"]>;

type GitHubApiTarget =
  | { ok: true; owner: string; repo: string; repositoryId: string }
  | { ok: false; status: 400 | 404; error: string; message: string };

export interface GitHubRouteDependencies {
  db: Database.Database;
  config: AgentConfig;
  secretBroker: SecretBroker;
  eventBus: EventBus;
  /** Optional GitWatcher to notify on webhook events (for fallback frequency adjustment) */
  onWebhookEvent?: () => void;
}

/**
 * GitHub Webhook receiver + API proxy routes.
 *
 * Webhook: POST /webhook/github — receives GitHub events, verifies signature,
 * parses event payload, and emits events to the EventBus.
 *
 * API Proxy: GET /github/repos, GET /github/pulls, POST /github/pulls/comment
 * — proxies requests to GitHub via @octokit/rest.
 */
/**
 * Create both webhook and API route apps separately.
 * - webhookApp: mount at root (/) → POST /webhook/github
 * - apiApp: mount at /api → GET /github/repos, GET /github/pulls, etc.
 */
export function createGitHubRoutes(deps: GitHubRouteDependencies): {
  webhookApp: Hono;
  apiApp: Hono;
} {
  // `config` was previously consumed via `config.gitRepos`; the unified-
  // repositories cutover routes that lookup through the store instead, so
  // the field is no longer destructured here. Kept on `deps` for callers
  // that pass a full `AgentConfig` object.
  const { db, eventBus, secretBroker, onWebhookEvent } = deps;

  let octokit: Octokit | null = null;
  let cachedToken: string | null = null;

  // Webhook rate limit: per-source bucket + global cap.
  //
  // Per-source key is the socket peer address (set by the kernel; not
  // spoofable across the network). `x-forwarded-for` was previously the
  // key, but a single header value lets any caller pin the bucket they
  // burn — turning the limiter into noise. Socket address handles two
  // realistic deployments:
  //   - Direct loopback: peer is always 127.0.0.1, so all attackers share
  //     one bucket (acceptable; daemon is loopback-only per design).
  //   - Tunnelled (ngrok / cloudflared): peer is the tunnel agent on
  //     loopback, so again one bucket per process — fine because the
  //     tunnel is trusted infrastructure and GitHub egress IPs are bounded.
  //
  // The global limiter is a defence against the bucket-shared-on-loopback
  // case: even if every request collapses into one bucket, total daemon
  // CPU spent on HMAC verification is bounded.
  const perSourceRateLimiter = new RateLimiter(60, 60_000);
  const globalRateLimiter = new RateLimiter(300, 60_000);

  async function getOctokit(): Promise<Octokit | null> {
    const githubToken = await secretBroker.getGitHubToken();
    if (!githubToken) return null;
    if (octokit && cachedToken === githubToken) return octokit;
    // No pending-promise coalescing: the only cost of a concurrent miss is one
    // extra `new Octokit({...})` (the dynamic import is module-cached after
    // the first call). Coalescing would also mean that a caller whose token
    // was rotated mid-flight could receive an Octokit auth'd with the prior
    // token — losing the cache-by-token guarantee this function provides.
    const { Octokit } = await import("@octokit/rest");
    octokit = new Octokit({ auth: githubToken });
    cachedToken = githubToken;
    return octokit;
  }

  function resolveGithubApiTarget(input: {
    owner?: string;
    repo?: string;
    repositoryId?: string;
  }): GitHubApiTarget {
    let row: RepositoryDTO | null = null;
    if (input.repositoryId) {
      row = resolveRepositoryIdentifier(db, input.repositoryId);
      if (!row) {
        return {
          ok: false,
          status: 404,
          error: "repository_not_found",
          message: "Repository id or slug is not registered",
        };
      }
    } else if (input.owner && input.repo && !input.repo.includes("/")) {
      row = getRepositoryByGithub(db, input.owner, input.repo);
      if (!row) {
        return {
          ok: false,
          status: 404,
          error: "repository_not_registered",
          message: `Repository ${input.owner}/${input.repo} is not registered`,
        };
      }
    } else if (input.repo) {
      row = resolveRepositoryIdentifier(db, input.repo);
      if (!row) {
        return {
          ok: false,
          status: 404,
          error: "repository_not_found",
          message: "Repository id or slug is not registered",
        };
      }
    } else {
      return {
        ok: false,
        status: 400,
        error: "validation_error",
        message: "owner/repo or repositoryId is required",
      };
    }

    if (!row.githubOwner || !row.githubRepo) {
      return {
        ok: false,
        status: 404,
        error: "github_side_required",
        message: "Repository has no GitHub side",
      };
    }
    return {
      ok: true,
      owner: row.githubOwner,
      repo: row.githubRepo,
      repositoryId: row.id,
    };
  }

  // ─── Webhook App (root-mounted) ───

  const webhookApp = new Hono();

  webhookApp.post("/webhook/github", async (c) => {
    // Resolve the connecting peer's socket address from Hono's env shim.
    // Hono normalises Node's `incoming.socket.remoteAddress` through
    // `c.env.incoming.socket.remoteAddress`. We wrap the lookup in
    // try/catch because future Hono adapter versions may expose
    // `c.env` as a getter that throws when the underlying shape is
    // missing — failing the entire webhook on a probe is worse than
    // bucketing this request on the shared "unknown" key (the global
    // limiter still applies).
    let peerAddr = "unknown";
    try {
      const env = c.env as
        | { incoming?: { socket?: { remoteAddress?: string } } }
        | undefined;
      peerAddr = env?.incoming?.socket?.remoteAddress ?? "unknown";
    } catch {
      // peerAddr stays "unknown"
    }

    if (!globalRateLimiter.allow("global")) {
      return respondWithAgentError(c, 429, [
        composeIssue("github.rate_limited", {
          field: "webhook",
          received: peerAddr,
        }),
      ]);
    }
    if (!perSourceRateLimiter.allow(peerAddr)) {
      return respondWithAgentError(c, 429, [
        composeIssue("github.rate_limited", {
          field: "webhook",
          received: peerAddr,
        }),
      ]);
    }

    // Webhook secret is required — refuse to operate without signature verification
    const webhookSecret = await secretBroker.getGitHubWebhookSecret();
    if (!webhookSecret) {
      return respondWithAgentError(c, 503, [
        composeIssue("github.webhook_not_configured", {
          field: "PA_GITHUB_WEBHOOK_SECRET",
          received: "<unset>",
        }),
      ], { legacyFields: { message: "PA_GITHUB_WEBHOOK_SECRET must be set" } });
    }

    // Read raw body for signature verification
    const rawBody = await c.req.text();

    const signature = c.req.header("x-hub-signature-256");
    if (!signature || !verifySignature(rawBody, signature, webhookSecret)) {
      logger.warn("GitHub webhook signature verification failed");
      return respondWithAgentError(c, 401, [
        composeIssue("github.invalid_signature", {
          field: "X-Hub-Signature-256",
          received: signature ?? "<missing>",
        }),
      ]);
    }

    const eventType = c.req.header("x-github-event");
    if (!eventType) {
      return respondWithAgentError(c, 400, [
        composeIssue("github.missing_event_type", {
          field: "X-GitHub-Event",
          received: "<missing>",
        }),
      ]);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return respondWithAgentError(c, 400, [
        composeIssue("github.invalid_json", {
          field: "body",
          received: "<invalid_json>",
        }),
      ]);
    }

    // Resolve `payload.repository.full_name` to a row id from the unified
    // store before emitting. Webhooks for repos not in the table are
    // dropped — this replaces the silent-fall-through behaviour of the
    // pre-cutover code.
    const repoFullName = (payload.repository as { full_name?: string } | undefined)
      ?.full_name;
    const resolved = resolveRepository(db, repoFullName);
    if (!resolved) {
      logger.info(
        { eventType, repoFullName: repoFullName ?? null },
        "GitHub webhook dropped — repository not in unified table",
      );
      try {
        db.prepare(
          `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
           VALUES ('dropped_unknown_repo', 'github-webhook', 'skipped', ?, datetime('now'))`,
        ).run(JSON.stringify({ eventType, repository: repoFullName ?? null }));
      } catch (err) {
        logger.warn({ err }, "Failed to record dropped_unknown_repo audit row");
      }
      return c.json({ status: "dropped_unknown_repo" });
    }

    const pushObservation = buildPushObservation(
      resolved.localPath,
      resolved.repositoryId,
      payload,
      eventType,
    );
    if (pushObservation) {
      recordObservation(db, pushObservation);
      logger.info(
        { eventType, repositoryId: resolved.repositoryId },
        "GitHub push observation recorded",
      );
    }

    const event = parseGitHubEvent(eventType, payload, resolved.repositoryId);
    if (event) {
      // `EventBus.put` is async; awaiting it (like the repositories routes do)
      // ensures the event is enqueued before the webhook returns `accepted`
      // and surfaces any enqueue rejection instead of dropping it as an
      // unhandled promise rejection.
      await eventBus.put(event);
      logger.info(
        { eventType, action: payload.action, repositoryId: resolved.repositoryId },
        "GitHub webhook event received",
      );
    }

    // Notify GitWatcher that webhook is alive (adjusts polling frequency)
    onWebhookEvent?.();

    return c.json({ status: "accepted" });
  });

  // ─── API Proxy App (mounted under /api) ───

  const apiApp = new Hono();

  // GET /github/repos — list watched repositories.
  // The legacy callers expected an array of `{ name }` objects derived from
  // local-clone basenames. Post-cutover the source of truth is the unified
  // `repositories` table — this returns one entry per row that has a
  // GitHub side, naming the row's `owner/repo` slug. Existing dashboard
  // fetches keep working because the response shape is unchanged
  // (still `{ repos: [{ name }, ...] }`); the names are now canonical.
  apiApp.get("/github/repos", async (c) => {
    const ok = await getOctokit();
    if (!ok) {
      return respondWithAgentError(c, 503, [
        composeIssue("github.not_configured", {
          field: "githubToken",
          received: "<unset>",
        }),
      ]);
    }

    const slugs = selectGithubRepoSlugs(db);
    return c.json({ repos: slugs.map((name) => ({ name })) });
  });

  // GET /github/pulls — list PRs for a registered repo.
  // Query: owner+repo, or repo=<row id | owner/repo | github:owner/repo>,
  // or repositoryId=<row id | slug>.
  apiApp.get("/github/pulls", async (c) => {
    const ok = await getOctokit();
    if (!ok) {
      return respondWithAgentError(c, 503, [
        composeIssue("github.not_configured", {
          field: "githubToken",
          received: "<unset>",
        }),
      ]);
    }

    const target = resolveGithubApiTarget({
      owner: c.req.query("owner"),
      repo: c.req.query("repo"),
      repositoryId: c.req.query("repositoryId") ?? c.req.query("id"),
    });
    if (!target.ok) {
      return respondWithAgentError(c, target.status, [
        composeIssue(githubTargetCode(target.error), {
          field: "repo",
          received: target.message,
        }),
      ], { legacyErrorCode: target.error, legacyFields: { message: target.message } });
    }

    const state = (c.req.query("state") ?? "open") as "open" | "closed" | "all";

    try {
      const { data } = await ok.pulls.list({
        owner: target.owner,
        repo: target.repo,
        state,
        per_page: 30,
      });

      return c.json({
        pulls: data.map((pr) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          user: pr.user?.login,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          html_url: pr.html_url,
          draft: pr.draft,
          labels: pr.labels.map((l) => (typeof l === "string" ? l : l.name)),
        })),
      });
    } catch (err) {
      logger.error({ err }, "GitHub pulls fetch failed");
      return respondWithAgentError(c, 502, [
        composeIssue("github.api_error", {
          field: "octokit",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // POST /github/pulls/comment — post a comment on a PR
  apiApp.post("/github/pulls/comment", async (c) => {
    const ok = await getOctokit();
    if (!ok) {
      return respondWithAgentError(c, 503, [
        composeIssue("github.not_configured", {
          field: "githubToken",
          received: "<unset>",
        }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const { owner, repo, repositoryId, id, pull_number, comment } = parsedBody.body as {
      owner?: string;
      repo?: string;
      repositoryId?: string;
      id?: string;
      pull_number?: number;
      comment?: string;
    };

    if (!pull_number || !comment) {
      return respondWithAgentError(c, 400, [
        composeIssue("github.pull_number_and_comment_required", {
          field: "body",
          received: { pull_number: pull_number ?? "<missing>", comment: comment ? "<set>" : "<missing>" },
        }),
      ]);
    }

    const target = resolveGithubApiTarget({
      owner,
      repo,
      repositoryId: repositoryId ?? id,
    });
    if (!target.ok) {
      return respondWithAgentError(c, target.status, [
        composeIssue(githubTargetCode(target.error), {
          field: "repo",
          received: target.message,
        }),
      ], { legacyErrorCode: target.error, legacyFields: { message: target.message } });
    }

    try {
      const { data } = await ok.issues.createComment({
        owner: target.owner,
        repo: target.repo,
        issue_number: pull_number,
        body: comment,
      });

      return c.json({ status: "commented", commentId: data.id, url: data.html_url });
    } catch (err) {
      logger.error({ err }, "GitHub comment failed");
      return respondWithAgentError(c, 502, [
        composeIssue("github.api_error", {
          field: "octokit",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  return { webhookApp, apiApp };
}

// ─── Helpers ───

/**
 * Map a GitHubApiTarget failure tag to the agent-error registry code.
 * Both 400 (`validation_error`) and 404 (`repository_not_*` / `github_side_required`)
 * have dedicated entries with retry hints.
 */
function githubTargetCode(tag: string): string {
  switch (tag) {
    case "repository_not_found":
      return "github.repository_not_found";
    case "repository_not_registered":
      return "github.repository_not_registered";
    case "github_side_required":
      return "github.side_required";
    case "validation_error":
      return "github.validation_error";
    default:
      return "github.repository_not_found";
  }
}

/** Verify GitHub webhook HMAC-SHA256 signature */
export function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

interface ResolvedRepository {
  repositoryId: string;
  localPath: string | null;
}

/**
 * Resolve `owner/repo` against the unified `repositories` table. Returns
 * null when the webhook arrives for an unknown repo — the caller drops
 * the event and records an `agent_actions` row.
 */
function resolveRepository(
  db: Database.Database,
  fullName: string | undefined,
): ResolvedRepository | null {
  if (!fullName) return null;
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return null;
  const row = getRepositoryByGithub(db, owner, repo);
  if (!row) return null;
  return { repositoryId: row.id, localPath: row.localPath };
}

function buildPushObservation(
  localRepoPath: string | null,
  repositoryId: string,
  payload: Record<string, unknown>,
  eventType: string,
): RecordObservationParams | null {
  if (eventType !== "push") {
    return null;
  }

  const repo = payload.repository as { full_name?: string } | undefined;
  const repoFullName = repo?.full_name;
  const headHash = typeof payload.after === "string"
    ? payload.after
    : typeof (payload.head_commit as { id?: string } | undefined)?.id === "string"
      ? (payload.head_commit as { id?: string }).id!
      : null;
  if (!repoFullName || !headHash) {
    return null;
  }

  const ref = typeof payload.ref === "string" ? payload.ref : undefined;
  const previousHash = typeof payload.before === "string" ? payload.before : undefined;
  const commits = Array.isArray(payload.commits)
    ? payload.commits as Array<Record<string, unknown>>
    : [];
  const pusher = payload.pusher as { name?: string } | undefined;
  const changedFiles = Array.from(
    new Set(
      commits.flatMap((commit) => {
        const added = Array.isArray(commit.added) ? commit.added : [];
        const modified = Array.isArray(commit.modified) ? commit.modified : [];
        const removed = Array.isArray(commit.removed) ? commit.removed : [];
        return [...added, ...modified, ...removed].filter((file): file is string => typeof file === "string");
      }),
    ),
  ).sort();

  const commitInfo = [
    `${commits.length} commit(s) pushed to ${ref ?? "unknown ref"} in ${repoFullName}`,
    pusher?.name ? `Pusher: ${pusher.name}` : "",
    ...commits.map((commit) => {
      const id = typeof commit.id === "string" ? commit.id.slice(0, 8) : headHash.slice(0, 8);
      const message = typeof commit.message === "string" ? commit.message.split("\n")[0] : "(no message)";
      const author = typeof (commit.author as { name?: string } | undefined)?.name === "string"
        ? (commit.author as { name?: string }).name
        : "unknown";
      return `${id} ${message} (${author})`;
    }),
  ].filter(Boolean).join("\n").slice(0, 3000);

  return {
    source: `git:${localRepoPath ?? repoFullName}`,
    ref: headHash,
    changeType: "modified",
    actor: "user",
    payload: {
      repositoryId,
      repoPath: localRepoPath ?? repoFullName,
      repository: repoFullName,
      commitHash: headHash,
      previousHash,
      commitInfo,
      changedFiles,
      commitCount: commits.length,
    },
  };
}

/** Parse non-push GitHub webhook events into EventBus events */
function parseGitHubEvent(
  eventType: string,
  payload: Record<string, unknown>,
  repositoryId: string,
): ReturnType<typeof createEvent> | null {
  const repo = payload.repository as { full_name: string } | undefined;
  const repoName = repo?.full_name ?? "unknown";

  switch (eventType) {
    case "pull_request": {
      const action = payload.action as string;
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      const priority =
        action === "review_requested"
          ? EventPriority.HIGH
          : EventPriority.NORMAL;

      return createEvent({
        type: `github.pull_request.${action}`,
        source: "github-webhook",
        priority,
        data: {
          repositoryId,
          repository: repoName,
          action,
          pullRequest: {
            number: pr?.number,
            title: pr?.title,
            user: (pr?.user as Record<string, unknown>)?.login,
            url: pr?.html_url,
            draft: pr?.draft,
          },
        },
      });
    }

    case "issues": {
      const action = payload.action as string;
      const issue = payload.issue as Record<string, unknown> | undefined;

      return createEvent({
        type: `github.issue.${action}`,
        source: "github-webhook",
        priority: EventPriority.LOW,
        data: {
          repositoryId,
          repository: repoName,
          action,
          issue: {
            number: issue?.number,
            title: issue?.title,
            user: (issue?.user as Record<string, unknown>)?.login,
            url: issue?.html_url,
          },
        },
      });
    }

    case "release": {
      const action = payload.action as string;
      const release = payload.release as Record<string, unknown> | undefined;

      return createEvent({
        type: `github.release.${action}`,
        source: "github-webhook",
        priority: EventPriority.NORMAL,
        data: {
          repositoryId,
          repository: repoName,
          action,
          release: {
            tag: release?.tag_name,
            name: release?.name,
            url: release?.html_url,
            prerelease: release?.prerelease,
          },
        },
      });
    }

    case "workflow_run": {
      const action = payload.action as string;
      const run = payload.workflow_run as Record<string, unknown> | undefined;

      if (action !== "completed") return null;

      return createEvent({
        type: "github.workflow_run.completed",
        source: "github-webhook",
        priority:
          (run?.conclusion as string) === "failure"
            ? EventPriority.HIGH
            : EventPriority.LOW,
        data: {
          repositoryId,
          repository: repoName,
          workflow: run?.name,
          conclusion: run?.conclusion,
          url: run?.html_url,
          branch: run?.head_branch,
        },
      });
    }

    default:
      logger.debug({ eventType }, "Unhandled GitHub event type");
      return null;
  }
}

/** Simple sliding-window rate limiter */
class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly windows = new Map<string, number[]>();
  private lastSweepAt = 0;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Periodic full sweep — bounds map size against the floods-of-unique-keys
    // case where the old per-key cleanup never runs because each key never
    // returns. Throttled to once per windowMs and only when the map has grown
    // past the threshold, so steady-state per-request cost stays O(W).
    if (this.windows.size > 1000 && now - this.lastSweepAt >= this.windowMs) {
      this.lastSweepAt = now;
      for (const [k, ts] of this.windows) {
        while (ts.length > 0 && ts[0] < cutoff) ts.shift();
        if (ts.length === 0) this.windows.delete(k);
      }
    }

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Remove expired timestamps for this key
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxRequests) return false;

    timestamps.push(now);
    return true;
  }
}
