import type { Octokit } from "@octokit/rest";
import { createLogger } from "../logging.js";

const logger = createLogger("github-service");

type OctokitModule = typeof import("@octokit/rest");

export interface GitHubPullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
}

export interface GitHubRepository {
  owner: string;
  repo: string;
  fullName: string;
  url: string;
}

/**
 * GitHubService — wraps @octokit/rest for GitHub API access.
 *
 * Used by:
 * - API route GET /api/github/repos (list monitored repos)
 * - API route GET /api/github/pulls (list PRs)
 * - API route POST /api/github/pulls/comment (comment on PRs)
 * - Webhook handler POST /webhook/github (validate & process webhooks)
 */
export class GitHubService {
  private readonly token: string | null;
  private readonly webhookSecret: string | null;
  private octokit: Octokit | null = null;

  constructor(
    token: string | null,
    webhookSecret: string | null,
  ) {
    this.token = token;
    this.webhookSecret = webhookSecret;
  }

  get available(): boolean {
    return !!this.token;
  }

  get webhookConfigured(): boolean {
    return !!this.webhookSecret;
  }

  async init(): Promise<void> {
    if (!this.available) {
      logger.warn("GitHub token not configured");
      return;
    }

    try {
      const mod = (await import("@octokit/rest" as string)) as OctokitModule;
      this.octokit = new mod.Octokit({ auth: this.token });
      logger.info("GitHub service initialized");
    } catch {
      throw new Error(
        "@octokit/rest not installed. Run: pnpm --filter @aitne/daemon add @octokit/rest",
      );
    }
  }

  /** List pull requests for a repository */
  async listPullRequests(
    owner: string,
    repo: string,
    state: "open" | "closed" | "all" = "open",
  ): Promise<GitHubPullRequest[]> {
    if (!this.octokit) return [];

    try {
      const { data } = await this.octokit.pulls.list({
        owner,
        repo,
        state,
        per_page: 20,
      });

      return data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.html_url,
        author: pr.user?.login ?? "",
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        draft: pr.draft ?? false,
      }));
    } catch (err) {
      logger.error({ err, owner, repo }, "Failed to list pull requests");
      return [];
    }
  }

  /** Comment on a pull request */
  async commentOnPull(
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
  ): Promise<{ commentId: number } | null> {
    if (!this.octokit) return null;

    try {
      const { data } = await this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
      });
      return { commentId: data.id };
    } catch (err) {
      logger.error(
        { err, owner, repo, pullNumber },
        "Failed to comment on pull request",
      );
      return null;
    }
  }

  /** Get repository info */
  async getRepo(
    owner: string,
    repo: string,
  ): Promise<GitHubRepository | null> {
    if (!this.octokit) return null;

    try {
      const { data } = await this.octokit.repos.get({ owner, repo });
      return {
        owner: data.owner.login,
        repo: data.name,
        fullName: data.full_name,
        url: data.html_url,
      };
    } catch (err) {
      logger.error({ err, owner, repo }, "Failed to get repository");
      return null;
    }
  }

  /**
   * Verify a GitHub webhook signature (X-Hub-Signature-256).
   *
   * Used by the webhook handler to ensure the payload is from GitHub.
   */
  async verifyWebhookSignature(
    payload: string,
    signature: string,
  ): Promise<boolean> {
    if (!this.webhookSecret) return false;

    const { createHmac } = await import("node:crypto");
    const expected =
      "sha256=" +
      createHmac("sha256", this.webhookSecret).update(payload).digest("hex");

    // Constant-time comparison
    if (expected.length !== signature.length) return false;
    const { timingSafeEqual } = await import("node:crypto");
    return timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  }
}
