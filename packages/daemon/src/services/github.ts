/**
 * GitHubService — thin "configured?" probe that lives in the service
 * registry. All actual GitHub API calls happen via per-caller @octokit/rest
 * instances:
 *   • `api/routes/github.ts` spins up its own Octokit for the proxy routes
 *     and verifies webhook signatures inline with `verifySignature`.
 *   • `observers/github-poller.ts` spins up its own per-account Octokit for
 *     polling.
 * This class only exposes the configured-state booleans the dashboard /
 * health surfaces consult — it doesn't wrap any API methods.
 */
export class GitHubService {
  private readonly token: string | null;
  private readonly webhookSecret: string | null;

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
}
