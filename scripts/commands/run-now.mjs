/**
 * `aitne run-now <job>` — fire a daemon-internal maintenance job on
 * demand.
 *
 * Currently supported jobs:
 *   - `roadmap_maintenance` — mechanical roadmap.md maintenance pass
 *     (substeps 2a / 2b / 2d of the legacy `routine.evening_review`
 *     Step 2). Same code path the 17:45 cron callback fires. See
 *     `docs/design/appendices/evening-review-slimdown.md` §2.2.
 *
 * Implementation:
 *   - Reads the daemon's apiToken from the macOS Keychain (the same
 *     entry the dashboard proxy uses). Bearer-auth required because
 *     `POST /api/agent/run-now/*` routes are Approve-tier in the
 *     `risk-classifier`.
 *   - POSTs to `http://127.0.0.1:<PA_API_PORT>/api/agent/run-now/<job>`.
 *   - Renders the structured `result` payload as a compact summary
 *     plus the full JSON on `--json`.
 *
 * Exit codes:
 *   - 0  job completed (including idempotent / no-op runs)
 *   - 2  validation / argument error
 *   - 3  daemon not running, not reachable, or 5xx
 *   - 4  result.status === "failed" — the job reported errors[]
 */
import { execFileSync } from "node:child_process";

const SUPPORTED_JOBS = new Set(["roadmap_maintenance"]);

const JOB_ENDPOINTS = {
  roadmap_maintenance: "/api/agent/run-now/roadmap-maintenance",
};

export async function run(args, ctx) {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const opts = parseArgs(args);
  if (!opts.job) {
    process.stderr.write("Job is required.\n");
    process.stderr.write("Available jobs: " + [...SUPPORTED_JOBS].join(", ") + "\n");
    process.stderr.write("Run `aitne help run-now` for usage.\n");
    process.exit(2);
  }

  if (!SUPPORTED_JOBS.has(opts.job)) {
    process.stderr.write(`Unknown job: ${opts.job}\n`);
    process.stderr.write("Available jobs: " + [...SUPPORTED_JOBS].join(", ") + "\n");
    process.exit(2);
  }

  const token = readApiToken();
  if (!token) {
    process.stderr.write(
      "Failed to read daemon API token from the macOS Keychain.\n" +
        "Is the daemon initialized? Run `aitne start` once first.\n",
    );
    process.exit(3);
  }

  const endpoint = JOB_ENDPOINTS[opts.job];
  const url = `http://127.0.0.1:${ctx.DAEMON_PORT}${endpoint}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
  } catch (err) {
    process.stderr.write(`Failed to reach the daemon at ${url}: ${err.message}\n`);
    process.stderr.write("Is the daemon running? Try `aitne status`.\n");
    process.exit(3);
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    process.stderr.write(
      `POST ${endpoint} → ${res.status}: ${body.error ?? "unknown"}\n`,
    );
    if (body.message) process.stderr.write(`${body.message}\n`);
    process.exit(res.status >= 500 ? 3 : 2);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
  } else {
    printSummary(opts.job, body.result ?? body);
  }

  const status = body?.result?.status;
  if (status === "failed") process.exit(4);
}

function parseArgs(args) {
  const opts = { job: null, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    if (a.startsWith("-")) {
      process.stderr.write(`Unknown flag: ${a}\n`);
      process.exit(2);
    }
    if (opts.job) {
      process.stderr.write(`Unexpected positional argument: ${a}\n`);
      process.exit(2);
    }
    opts.job = a;
  }
  return opts;
}

function readApiToken() {
  try {
    return execFileSync(
      "security",
      [
        "find-generic-password",
        "-s",
        "com.personal-agent.secret.apiToken",
        "-w",
      ],
      { encoding: "utf-8" },
    ).trim();
  } catch {
    return null;
  }
}

function printSummary(job, result) {
  if (job === "roadmap_maintenance") {
    if (!result || typeof result !== "object") {
      process.stdout.write("(no result payload)\n");
      return;
    }
    const status = result.status ?? "unknown";
    const lines = [
      `status:           ${status}`,
      `status_synced:    ${result.statusSynced ?? 0}`,
      `swept:            ${result.swept ?? 0}`,
      `stale_marked:     ${result.staleMarked ?? 0}`,
    ];
    if (result.skipReason) lines.push(`skip_reason:      ${result.skipReason}`);
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      lines.push(`errors:           ${result.errors.length}`);
      for (const err of result.errors) {
        lines.push(`  - ${err.step}: ${err.message}`);
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function printHelp() {
  process.stdout.write(`Usage: aitne run-now <job> [--json]

Fire a daemon-internal maintenance job on demand. Uses the same code
path the cron schedule fires — useful for parallel-verification
rollouts and operator debugging.

Jobs:
  roadmap_maintenance   Run the mechanical roadmap.md maintenance pass
                        (substeps 2a / 2b / 2d). Acquires roadmap write
                        lock, syncs Scheduled: statuses, sweeps aged
                        Agent Action Plan entries, and applies
                        Long-term Plans stale markers. Emits an
                        \`agent_actions\` audit row with
                        action_type='roadmap_mechanical_maintenance'
                        and appends a line to agent/journal.md.

Flags:
  --json    Emit the full JSON result instead of the summary.
  -h, --help  Print this message.

Exit codes:
  0   completed (success / skipped)
  2   argument / validation error
  3   daemon unreachable or 5xx
  4   the job ran but reported errors[]

Examples:
  aitne run-now roadmap_maintenance
  aitne run-now roadmap_maintenance --json
`);
}
