import { EventPriority } from "@aitne/shared";

/**
 * GitHub Notifications API row — fields we care about. The shape is the
 * subset the poller deserializes from `gh api notifications`; full upstream
 * schema lives at https://docs.github.com/en/rest/activity/notifications.
 */
export interface GitHubNotification {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  subject: {
    title: string;
    type: string;
    url: string | null;
  };
  repository: {
    full_name: string;
    html_url?: string;
  };
}

/**
 * GitHub workflow_run row from `gh api repos/<o>/<r>/actions/runs`. Only the
 * subset the classifier reads.
 */
export interface GitHubWorkflowRun {
  id: number;
  name: string;
  display_title?: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  html_url: string;
  updated_at: string;
  event: string;
}

export type Classification =
  | { kind: "skip"; reason: string }
  | {
      kind: "observe";
      eventType: string;
      priority: EventPriority;
      changeType: "created" | "modified" | "deleted";
      source: string;
      ref: string;
      payload: Record<string, unknown>;
      /**
       * When `true`, the orchestrator emits to EventBus in addition to
       * recording the observation. Reserved for HIGH-priority signals that
       * should DM the user without waiting for the hourly check.
       */
      emitEvent: boolean;
    };

/**
 * Map a GitHub notifications-API `reason` to (event type, priority,
 * emit-to-EventBus) per the agent's "patterns not events" philosophy.
 *
 * - `review_requested` / `assign` / `security_alert` are HIGH and bypass
 *   hourly_check via direct DM.
 * - `mention` / `team_mention` are NORMAL — coalesced in hourly_check.
 * - `subscribed` / `manual` / `comment` / `state_change` etc. are LOW
 *   noise; recorded as observations only so the agent can surface them
 *   if a pattern emerges.
 *
 * Unknown reasons fall through to LOW + observation-only.
 */
export function classifyNotification(
  notification: GitHubNotification,
): Classification {
  if (!notification.unread) {
    return { kind: "skip", reason: "already_read" };
  }

  const repoFullName = notification.repository.full_name;
  const subjectType = notification.subject.type;
  const subjectTitle = notification.subject.title;
  const baseRef = `notification:${notification.id}`;
  const source = `github:notification:${repoFullName}`;
  const basePayload = {
    repository: repoFullName,
    reason: notification.reason,
    subjectType,
    subjectTitle,
    // Coerce null to empty string — `extractEventData` stringifies every
    // value into the prompt, and `String(null)` is the literal `"null"`,
    // which would render as "null" in the task-flow output.
    subjectUrl: notification.subject.url ?? "",
    notificationId: notification.id,
    updatedAt: notification.updated_at,
  };

  switch (notification.reason) {
    case "review_requested":
      return {
        kind: "observe",
        eventType: "github.pull_request.review_requested",
        priority: EventPriority.HIGH,
        changeType: "created",
        source,
        ref: baseRef,
        payload: basePayload,
        emitEvent: true,
      };
    case "assign":
      return {
        kind: "observe",
        eventType: "github.assigned",
        priority: EventPriority.HIGH,
        changeType: "created",
        source,
        ref: baseRef,
        payload: basePayload,
        emitEvent: true,
      };
    case "security_alert":
      return {
        kind: "observe",
        eventType: "github.security_alert",
        priority: EventPriority.HIGH,
        changeType: "created",
        source,
        ref: baseRef,
        payload: basePayload,
        emitEvent: true,
      };
    case "mention":
    case "team_mention":
      return {
        kind: "observe",
        eventType: "github.mention",
        priority: EventPriority.NORMAL,
        changeType: "created",
        source,
        ref: baseRef,
        payload: basePayload,
        emitEvent: false,
      };
    case "ci_activity":
      // CI activity through the notifications API is opt-in per-user; treat
      // it as low-priority observation. The dedicated workflow_runs poll
      // catches concrete failures with full context.
      return {
        kind: "observe",
        eventType: "github.ci_activity",
        priority: EventPriority.LOW,
        changeType: "modified",
        source,
        ref: baseRef,
        payload: basePayload,
        emitEvent: false,
      };
    default:
      return {
        kind: "observe",
        eventType: "github.notification",
        priority: EventPriority.LOW,
        changeType: "created",
        source,
        ref: baseRef,
        payload: basePayload,
        emitEvent: false,
      };
  }
}

/**
 * Classify a workflow_run row. HIGH + EventBus emission only when the run
 * failed on the repository's default branch — feature-branch failures are
 * the developer's normal feedback loop, not an interruption-worthy signal.
 *
 * Non-failures and in-progress runs return `skip`.
 */
export function classifyWorkflowRun(
  run: GitHubWorkflowRun,
  defaultBranch: string,
  repoFullName: string,
): Classification {
  if (run.status !== "completed") {
    return { kind: "skip", reason: "not_completed" };
  }
  if (run.conclusion !== "failure" && run.conclusion !== "timed_out") {
    return { kind: "skip", reason: "not_failed" };
  }

  const onDefaultBranch = run.head_branch === defaultBranch;
  const source = `github:workflow:${repoFullName}`;
  const ref = `workflow_run:${run.id}`;
  const payload: Record<string, unknown> = {
    repository: repoFullName,
    workflowName: run.name,
    displayTitle: run.display_title ?? run.name,
    branch: run.head_branch,
    defaultBranch,
    onDefaultBranch,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    runId: run.id,
    updatedAt: run.updated_at,
    triggerEvent: run.event,
  };

  return {
    kind: "observe",
    eventType: "github.workflow_run.failed",
    priority: onDefaultBranch ? EventPriority.HIGH : EventPriority.LOW,
    changeType: "modified",
    source,
    ref,
    payload,
    // Only DM-grade for default-branch failures. Feature-branch failures
    // are noise during normal development and only surface via hourly_check.
    emitEvent: onDefaultBranch,
  };
}

/**
 * Parse a git remote URL into `{ owner, repo }`. Returns `null` for any
 * non-GitHub URL or an unparseable form. Recognized:
 *
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   ssh://git@github.com/owner/repo.git
 */
export function parseGitHubRemote(
  remoteUrl: string,
): { owner: string; repo: string } | null {
  const trimmed = remoteUrl.trim();
  // SSH form: git@github.com:owner/repo(.git)?
  const sshMatch = trimmed.match(
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  // HTTPS form: https://github.com/owner/repo(.git)?
  const httpsMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  return null;
}

/**
 * Parse a configured GitHub repository identifier. The dashboard stores
 * direct watched repos as `owner/repo`, but accepting GitHub HTTPS/SSH URLs
 * here keeps env-driven installs forgiving without broadening the persisted
 * schema.
 */
export function parseGitHubRepoFullName(
  value: string,
): { owner: string; repo: string; fullName: string } | null {
  const trimmed = value.trim();
  const remote = parseGitHubRemote(trimmed);
  if (remote) {
    return {
      ...remote,
      fullName: `${remote.owner}/${remote.repo}`,
    };
  }
  const match = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    fullName: `${match[1]}/${match[2]}`,
  };
}
