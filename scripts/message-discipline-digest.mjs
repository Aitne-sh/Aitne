#!/usr/bin/env node
// MESSAGING-DISCIPLINE-PLAN.md §5.1 — message-discipline post-ship monitor.
//
// Reads notification_log + agent_actions for a given day, classifies every
// user-facing message against opener_forbidden / readback_suspected /
// clean, and posts a low-priority digest DM via /api/notify so the owner
// can audit whether the new universal-discipline rules are actually
// holding in production.
//
// Mechanism rationale (§5.1): the prompt-text exit criteria in Phases
// 0-2 confirm the universal discipline section is *written* correctly.
// They do not detect agent behavior regressions — that signal previously
// only arrived via the owner manually flagging a message. This digest
// closes the loop by surfacing every user-facing emission for the day
// with regex classification, so a regression is caught the next morning,
// not weeks later.
//
// USAGE
// -----
//   # Compose + send today's digest (defaults to today)
//   node scripts/message-discipline-digest.mjs --send
//
//   # Compose + print without sending
//   node scripts/message-discipline-digest.mjs --date 2026-04-26
//
//   # Seed 7 nightly agent_schedule rows at 22:00 local for the next 7 days
//   node scripts/message-discipline-digest.mjs --seed
//
//   # Override defaults
//   node scripts/message-discipline-digest.mjs --send --date 2026-04-25 \
//        --base-url http://localhost:8321 --db-path ~/.personal-agent/data/personal_agent.db
//
// FLAGS
//   --send                 POST the digest via /api/notify (priority `low`).
//                          Without this flag the digest is printed to stdout.
//   --date YYYY-MM-DD      The day to digest. Defaults to today (local).
//   --base-url URL         Daemon base URL. Default http://localhost:8321.
//   --db-path PATH         SQLite path. Default $PA_DATA_DIR/data/personal_agent.db
//                          or ~/.personal-agent/data/personal_agent.db.
//   --seed                 Insert 7 nightly agent_schedule rows starting
//                          tomorrow at --time (default 22:00 local).
//   --days N               (with --seed) how many evenings to seed. Default 7.
//   --time HH:MM           (with --seed) local time of day. Default 22:00.
//   --start-date YYYY-MM-DD (with --seed) first evening. Default tomorrow.
//
// CLASSIFICATION REGEXES (seed list — extend as the owner flags misses):
//   opener_forbidden — leading ceremony phrases the universal section
//                      (notify/SKILL.md § Universal user-facing message
//                      discipline § No ceremony) bans. Applies to EVERY
//                      user-facing surface — the no-ceremony rule has no
//                      conversational carve-out.
//   readback_suspected — `Schedule:` / `Tasks:` / `Deadlines:` /
//                        `Notes:` lines as leading labels — likely
//                        readback of the user's own data, banned by
//                        § No table-of-contents readback. Applied ONLY
//                        to PROACTIVE surfaces (POST /api/notify,
//                        scheduled.dm, scheduled_dm). DM replies under
//                        message.received.* get a conversational carve-
//                        out per agent-profiles/conversational.md — when
//                        the user explicitly asks for their own data,
//                        returning it plainly is legal. Running the
//                        readback regex over those rows would produce
//                        systematic false positives that erode owner
//                        attention to the digest.
//
// IMPLEMENTATION NOTES
//   - Reads SQLite via the system `sqlite3` CLI (`-json`) so the script
//     has zero npm runtime deps. macOS ships sqlite3 ≥ 3.43, which
//     supports `-json`. On Linux without sqlite3 CLI installed, the
//     script will exit with a clear error.
//   - The plan permits no daemon code change, so the script reads the
//     DB directly (read-only intent — `--seed` is the one write path,
//     and it INSERTs only `agent_schedule` rows that the daemon
//     scheduler already understands).
//   - Posts via global `fetch` (Node ≥ 18). Project pins Node ≥ 22.

import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");

const FORBIDDEN_OPENERS_RE =
  /^(?:Good\s+(?:morning|evening|afternoon)|Evening\s+check-in|Morning\s+briefing|Heads-up|FYI|Quick\s+update|Summary|Done|Sent|OK|Here's|Here\sis)\b/i;
const READBACK_RE =
  /^(?:Schedule|Tasks|Deadlines|Notes)\s*:/im;

function parseArgs(argv) {
  const args = { send: false, seed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send") args.send = true;
    else if (a === "--seed") args.seed = true;
    else if (a === "--date") args.date = argv[++i];
    else if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a === "--db-path") args.dbPath = argv[++i];
    else if (a === "--start-date") args.startDate = argv[++i];
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--time") args.time = argv[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}. Use --help for usage.`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  // Help text is the file header above; print the relevant portion.
  console.log(
    "Usage:\n" +
      "  node scripts/message-discipline-digest.mjs [--send] [--date YYYY-MM-DD]\n" +
      "  node scripts/message-discipline-digest.mjs --seed [--start-date YYYY-MM-DD]\n" +
      "                                              [--days N] [--time HH:MM]\n" +
      "Run with --help for the full header in the source file.",
  );
}

function resolveDbPath(override) {
  if (override) return override;
  const dataDir = process.env.PA_DATA_DIR || path.join(os.homedir(), ".personal-agent");
  return path.join(dataDir, "data", "personal_agent.db");
}

function todayLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysLocal(yyyymmdd, n) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function localIsoAt(dateStr, hhmm) {
  // Returns an ISO-8601 string with the local timezone offset for
  // `<dateStr>T<hhmm>:00` interpreted in the user's local zone. The daemon
  // accepts any parseable date string (POST /api/schedule does
  // `new Date(time)`); attaching the offset eliminates ambiguity.
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const dt = new Date(y, m - 1, d, hh, mm, 0);
  const tzMin = -dt.getTimezoneOffset();
  const sign = tzMin >= 0 ? "+" : "-";
  const absMin = Math.abs(tzMin);
  const tzh = String(Math.floor(absMin / 60)).padStart(2, "0");
  const tzm = String(absMin % 60).padStart(2, "0");
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}` +
    `T${pad(dt.getHours())}:${pad(dt.getMinutes())}:00${sign}${tzh}:${tzm}`
  );
}

async function querySqlite(dbPath, sql) {
  // Open the DB in-process via better-sqlite3 (the same native binding the
  // daemon runs) rather than shelling out to the system `sqlite3` CLI, which
  // is absent on Windows and many Linux/macOS installs. `loadBetterSqlite3`
  // handles the pnpm-dev vs installed-package resolution on all three OSes.
  const { loadBetterSqlite3 } = await import("./lib/sqlite-loader.mjs");
  const Database = await loadBetterSqlite3(PROJECT_ROOT);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/**
 * Classify a user-facing message against the universal-discipline regexes.
 *
 * The `surface` argument controls which rules apply. Only "proactive"
 * surfaces (the agent decided to message the user without being asked)
 * are subject to the readback regex; "reactive" surfaces (DM replies)
 * are exempt because conversational.md explicitly carves out
 * user-requested data readback as legal — the universal section's
 * "no readback" rule's load-bearing rationale ("the user already has
 * it") doesn't hold when the user just asked for it. The opener regex
 * always applies; the no-ceremony rule has no conversational carve-out.
 *
 * @param {string} text
 * @param {"proactive"|"reactive"} surface
 */
function classify(text, surface = "proactive") {
  if (!text) return "clean";
  const stripped = text.trim();
  // Strip a single leading markdown bullet / heading marker — a digest
  // bullet like "- Good morning" still violates the no-ceremony rule.
  const noBullet = stripped.replace(/^(?:[-*]\s+|#+\s+)/, "");
  if (FORBIDDEN_OPENERS_RE.test(noBullet)) return "opener_forbidden";
  if (surface === "proactive" && READBACK_RE.test(noBullet)) {
    return "readback_suspected";
  }
  return "clean";
}

function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

async function loadDayData(dbPath, date) {
  // notification_log carries every user-facing emission. The
  // notification_type column distinguishes the source surface:
  //
  //   notification_type='agent'           — POST /api/notify (every call,
  //                                         set in packages/daemon/src/index.ts
  //                                         sendNotification + agent.ts:357
  //                                         /notify route)
  //   notification_type='scheduled.dm'    — LLM-composed Morning briefing
  //                                         (and any future scheduled.dm
  //                                         sub-flow) — final assistant
  //                                         text written by
  //                                         notification-manager.send,
  //                                         which logs notification_type =
  //                                         event.type literally
  //   notification_type='scheduled_dm'    — pre-composed direct DM
  //                                         (task_type='dm') from
  //                                         scheduler.ts:handleDirectDm,
  //                                         no LLM involved
  //   notification_type='message.received.*' — DM reply to an inbound
  //                                            user DM (final-text,
  //                                            notification-manager auto-
  //                                            send via dispatcher)
  //   notification_type='schedule.approaching' / 'calendar.*' / etc. —
  //     other event-typed auto-sends, currently unused for user-facing
  //     text (the schedule.approaching prompt routes through /api/notify,
  //     so its rows land under 'agent', not under the event type).
  //
  // The buckets below mirror the §5.1 surfaces — /api/notify, scheduled
  // DMs (LLM and direct), DM replies — so the regex classifier runs over
  // every user-visible row produced that day.
  const notifications = await querySqlite(
    dbPath,
    `SELECT id, notification_type, priority, content_summary, status, platform, created_at
       FROM notification_log
      WHERE date(created_at, 'localtime') = ${sqlString(date)}
      ORDER BY created_at ASC`,
  );
  // schedule.approaching event firings: count agent_actions rows with
  // action_type='schedule.approaching'. We deliberately do NOT split into
  // notified/skipped here — there is no clean join from agent_actions to
  // notification_log (notification_log has no event_id / correlationId
  // column, and /api/notify rewrites notification_type to 'agent', so a
  // filter on 'schedule.approaching' would always be 0). Reporting a fake
  // split produced misleading "100% skipped" digests; an honest total
  // plus the global notify-row classifier covers regression detection.
  const approachingActions = await querySqlite(
    dbPath,
    `SELECT id, started_at, completed_at, result
       FROM agent_actions
      WHERE action_type = 'schedule.approaching'
        AND date(started_at, 'localtime') = ${sqlString(date)}
      ORDER BY started_at ASC`,
  );
  return { notifications, approachingActions };
}

function sqlString(s) {
  // Inline literal string — `s` is always a controlled value (date in
  // YYYY-MM-DD form from local arithmetic). Defense-in-depth: reject
  // anything that doesn't match the date pattern.
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) {
    throw new Error(`refusing to inline non-date value into SQL: ${s}`);
  }
  return `'${s}'`;
}

function buildDigest(date, { notifications, approachingActions }) {
  // Bucket rows by surface so the regex classifier runs over every
  // user-visible emission. See loadDayData header comment for the
  // notification_type taxonomy.
  const notifyApi = notifications.filter(
    (n) => n.notification_type === "agent",
  );
  // Both spellings cover the scheduled-DM surface: 'scheduled.dm' is
  // notification-manager logging event.type literally for the LLM-composed
  // path (Morning briefing); 'scheduled_dm' is scheduler.handleDirectDm
  // for pre-composed direct DMs.
  const scheduledDm = notifications.filter(
    (n) =>
      n.notification_type === "scheduled.dm" ||
      n.notification_type === "scheduled_dm",
  );
  const dmReplies = notifications.filter((n) =>
    typeof n.notification_type === "string" &&
    n.notification_type.startsWith("message.received"),
  );
  const otherNotifications = notifications.filter(
    (n) =>
      n.notification_type !== "agent" &&
      n.notification_type !== "scheduled.dm" &&
      n.notification_type !== "scheduled_dm" &&
      !(
        typeof n.notification_type === "string" &&
        n.notification_type.startsWith("message.received")
      ),
  );

  const totalApproaching = approachingActions.length;

  const lines = [];
  lines.push(`message-discipline digest — ${date}`);
  lines.push("");

  lines.push(`POST /api/notify calls: ${notifyApi.length}`);
  for (const n of notifyApi) {
    lines.push(formatNotifyLine(n));
  }
  if (notifyApi.length === 0) lines.push("- (none)");
  lines.push("");

  lines.push(`scheduled.dm final-text DMs: ${scheduledDm.length}`);
  for (const n of scheduledDm) {
    lines.push(formatNotifyLine(n));
  }
  if (scheduledDm.length === 0) lines.push("- (none)");
  lines.push("");

  lines.push(`message.received.* DM replies: ${dmReplies.length}`);
  for (const n of dmReplies) {
    lines.push(formatNotifyLine(n));
  }
  if (dmReplies.length === 0) lines.push("- (none)");
  lines.push("");

  if (otherNotifications.length > 0) {
    lines.push(`other notification_log rows: ${otherNotifications.length}`);
    for (const n of otherNotifications) {
      lines.push(formatNotifyLine(n));
    }
    lines.push("");
  }

  // Honest reporting: agent_actions has no clean join to notification_log
  // (no shared event_id / correlationId column), and /api/notify writes
  // notification_type='agent', so we cannot tell which approaching events
  // produced a notification without timestamp-window heuristics. Surface
  // the total here; the regex classification above already covers any
  // notify rows the firing session emitted.
  lines.push(`schedule.approaching events: total=${totalApproaching}`);
  lines.push(
    "  (notified vs skipped split not derivable — notification_log has no event_id; trigger attribution a/d also pending instrumentation)",
  );
  lines.push("");

  // Roll-up of flags across every user-visible surface. This is the line
  // the owner glances at first; if it's all-zero for 7 days the digest is
  // retired (§5.1 Action rules). Each row is classified at its own
  // surface — readback_suspected is suppressed for DM replies because
  // conversational.md carves out user-requested data readback as legal.
  const allMessages = [
    ...notifyApi,
    ...scheduledDm,
    ...dmReplies,
    ...otherNotifications,
  ];
  const flagCounts = { opener_forbidden: 0, readback_suspected: 0, clean: 0 };
  for (const m of allMessages) {
    flagCounts[classify(m.content_summary, surfaceFor(m))]++;
  }
  lines.push(
    `flags: opener_forbidden=${flagCounts.opener_forbidden} readback_suspected=${flagCounts.readback_suspected} clean=${flagCounts.clean}`,
  );

  return lines.join("\n");
}

/**
 * Decide whether a notification_log row counts as a "proactive" surface
 * for classifier purposes. DM replies (message.received.*) are reactive;
 * everything else (agent / scheduled.dm / scheduled_dm / etc.) is the
 * agent reaching out unprompted.
 */
function surfaceFor(n) {
  if (
    typeof n.notification_type === "string" &&
    n.notification_type.startsWith("message.received")
  ) {
    return "reactive";
  }
  return "proactive";
}

function formatNotifyLine(n) {
  const cls = classify(n.content_summary, surfaceFor(n));
  const tag = cls === "clean" ? "✓" : `⚠ ${cls}`;
  const summary = truncate((n.content_summary ?? "").replace(/\s+/g, " "), 120);
  const type = n.notification_type ?? "(none)";
  const priority = n.priority ?? "(none)";
  return `- [${priority}] ${type} ${tag} :: ${summary}`;
}

async function postDigest(baseUrl, message) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/notify`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, priority: "low" }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${url} → ${res.status}: ${text}`);
  }
  return text;
}

async function runDigest(args) {
  const date = args.date ?? todayLocal();
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
    console.error(`Invalid --date: ${date}. Expected YYYY-MM-DD.`);
    process.exit(2);
  }
  const dbPath = resolveDbPath(args.dbPath);
  const baseUrl = args.baseUrl ?? "http://localhost:8321";

  const data = await loadDayData(dbPath, date);
  const digest = buildDigest(date, data);

  if (args.send) {
    const reply = await postDigest(baseUrl, digest);
    console.log(`Digest sent. Daemon response: ${reply}`);
  } else {
    console.log(digest);
    console.log(
      `\n(Use --send to POST this via ${baseUrl}/api/notify at priority \`low\`.)`,
    );
  }
}

async function runSeed(args) {
  const days = args.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    console.error(`Invalid --days: ${days}. Expected 1..30.`);
    process.exit(2);
  }
  const time = args.time ?? "22:00";
  if (!/^[0-2][0-9]:[0-5][0-9]$/.test(time)) {
    console.error(`Invalid --time: ${time}. Expected HH:MM.`);
    process.exit(2);
  }
  const start = args.startDate ?? addDaysLocal(todayLocal(), 1);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(start)) {
    console.error(`Invalid --start-date: ${start}. Expected YYYY-MM-DD.`);
    process.exit(2);
  }

  const baseUrl = (args.baseUrl ?? "http://localhost:8321").replace(/\/+$/, "");
  const url = `${baseUrl}/api/schedule`;

  // Description is plumbed straight into {event_data[task]} of the
  // generated scheduled.task event. Encode the date and the explicit
  // invocation so the firing LLM session has zero judgment to exercise:
  // it sees a deterministic Bash command + a "do not duplicate
  // delivery" instruction and exits.
  const seeded = [];
  for (let i = 0; i < days; i++) {
    const date = addDaysLocal(start, i);
    const iso = localIsoAt(date, time);
    const description =
      `Run message-discipline digest for ${date}: invoke ` +
      `\`node scripts/message-discipline-digest.mjs --date ${date} --send\` ` +
      `via Bash from the repo root. The script itself POSTs the digest via ` +
      `/api/notify at priority \`low\`; you must NOT compose or send a ` +
      `duplicate notification. Log one line to today.md ## Agent Log on ` +
      `completion (e.g. \`HH:MM [digest] message-discipline digest sent\`).`;
    const body = {
      time: iso,
      taskType: "agent_task",
      description,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const replyText = await res.text();
    if (!res.ok) {
      console.error(`Failed to seed ${date} @ ${time}: ${res.status} ${replyText}`);
      process.exit(1);
    }
    seeded.push({ date, iso, response: replyText });
  }

  console.log(
    `Seeded ${seeded.length} message-discipline digest agent_schedule rows:`,
  );
  for (const s of seeded) {
    console.log(`  ${s.date} ${s.iso}  ${s.response}`);
  }
  console.log(
    "\nThe firing LLM session will need to invoke `node` from Bash. The default\n" +
      "Claude allowed-tools list does NOT include Bash(node *), so the user will\n" +
      "be prompted to approve the command pattern on first fire. Approve once,\n" +
      "or pre-add `Bash(node *)` to the dashboard's allowed-tools override.",
  );
  console.log(
    "\nAlternative without LLM round-trips: schedule the script directly via\n" +
      "launchd / cron with the same daily cadence. Example launchd plist on macOS:\n" +
      "  ProgramArguments = (\"/usr/local/bin/node\", \"<repo>/scripts/message-discipline-digest.mjs\", \"--send\")\n" +
      "  StartCalendarInterval = { Hour = 22; Minute = 0; }\n" +
      "Run for 7 days, then `launchctl unload` to retire.",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.seed) {
    await runSeed(args);
  } else {
    await runDigest(args);
  }
}

main().catch((err) => {
  console.error(err.stack ?? err.message ?? String(err));
  process.exit(1);
});
