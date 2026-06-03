/**
 * `aitne doctor` — diagnose install-time problems.
 *
 * Eight independent checks. Each returns a status (pass / warn / fail), a
 * short detail line, and an optional hint that tells the user what to do.
 * The single most common failure mode for new users is "I installed it but
 * something is wrong" — doctor narrows that to "row N failed: do X."
 *
 * Doctor is read-only and offline. No daemon is started, no DB is mutated,
 * no network call is made. Safe to run at any time.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export async function run(args, ctx) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: aitne doctor [--json]

Run a series of install-health checks and report pass/warn/fail. Useful as
a first step when triaging "it doesn't work" — most first-install failures
are exactly one of these checks.

Flags:
  --json         Machine-readable output. Implies no terminal formatting.

Exit code:
  0              All checks pass (warnings are tolerated).
  1              At least one check failed.`);
    return;
  }

  const checks = [
    await checkNodeVersion(),
    await checkPort("Daemon port", ctx.DAEMON_PORT, ctx.DAEMON_PID_FILE, ctx.helpers.getRunningPid),
    await checkPort("Dashboard port", ctx.DASHBOARD_PORT, ctx.DASHBOARD_PID_FILE, ctx.helpers.getRunningPid),
    await checkSecretStore(ctx),
    await checkBackendCli(),
    await checkProcessProbe(),
    await checkBrowserOpener(ctx.DASHBOARD_PORT),
    await checkDataDirWritable(ctx.DATA_DIR),
    await checkBetterSqlite3(ctx.PROJECT_ROOT),
    await checkAgentAssets(ctx.PROJECT_ROOT),
    ...(await checkRepositoryGithubLinkDrift(ctx.DATA_DIR)),
  ];

  const passed = checks.filter((c) => c.status === "pass").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;

  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ checks, passed, warned, failed }, null, 2) + "\n");
    process.exit(failed > 0 ? 1 : 0);
  }

  console.log(`${ctx.APP_NAME} v${ctx.VERSION} doctor — ${checks.length} checks`);
  console.log("");

  // Right-pad label to widest so the detail column lines up.
  const labelWidth = Math.max(...checks.map((c) => c.label.length));
  for (const c of checks) {
    const mark = c.status === "pass" ? "ok " : c.status === "warn" ? "warn" : "FAIL";
    const label = c.label.padEnd(labelWidth);
    console.log(`  [${mark}]  ${label}  ${c.detail}`);
    if (c.hint && c.status !== "pass") {
      console.log(`           ${" ".repeat(labelWidth)}  hint: ${c.hint}`);
    }
  }
  console.log("");
  console.log(`${passed} ok · ${warned} warn · ${failed} fail`);
  process.exit(failed > 0 ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────
// Individual checks. Each is an async function returning
// { status, label, detail, hint? }. Independent — never throw.
// ─────────────────────────────────────────────────────────────────────────

async function checkNodeVersion() {
  const v = process.versions.node; // e.g. "22.10.0"
  const major = parseInt(v.split(".")[0], 10) || 0;
  if (major >= 22) {
    return { status: "pass", label: "Node version", detail: `v${v} (>= 22)` };
  }
  return {
    status: "fail",
    label: "Node version",
    detail: `v${v} — too old (need >= 22)`,
    hint: "Install Node 22 LTS, then re-run. `corepack enable` is bundled with 22+.",
  };
}

/**
 * Check whether a port is either (a) bindable, or (b) already held by our own
 * PID file. If neither, we surface a fail — something else is on the port and
 * the user needs to know.
 *
 * `getRunningPid` is passed in (rather than re-implemented inline) so the
 * stale-PID handling stays consistent with `aitne start`'s view of "is our
 * daemon up?". Inlining it would drift over time.
 */
async function checkPort(label, port, pidFile, getRunningPid) {
  // (b) — our own daemon already running.
  const pid = getRunningPid(pidFile);
  if (pid != null) {
    return {
      status: "pass",
      label,
      detail: `${port} held by ${label.split(" ")[0].toLowerCase()} PID ${pid}`,
    };
  }

  // (a) — try to bind. If success, port is free.
  const free = await new Promise((resolve) => {
    const sock = net.createServer();
    sock.unref();
    sock.once("error", () => { resolve(false); });
    sock.listen(port, "127.0.0.1", () => {
      sock.close(() => resolve(true));
    });
  });

  if (free) return { status: "pass", label, detail: `${port} free` };
  return {
    status: "fail",
    label,
    detail: `${port} in use by another process`,
    hint: label.startsWith("Daemon")
      ? `Set PA_API_PORT to an open port (e.g. PA_API_PORT=8331 aitne start), or stop the conflicting process.`
      : `Set PA_DASHBOARD_PORT to an open port (e.g. PA_DASHBOARD_PORT=8333 aitne start), or stop the conflicting process.`,
  };
}

/**
 * OS-specific secret-store probe. Per README §Platform support:
 *  - macOS: `security` CLI is in-box; just verify it executes.
 *  - Linux: `secret-tool` is preferred; the file fallback needs
 *    PA_MASTER_PASSWORD or a keyfile present.
 *  - Windows: PowerShell DPAPI is in-box; prefer `powershell.exe` and
 *    fall back to `pwsh.exe`.
 *
 * Failure here is "warn" (not "fail") because the daemon's
 * file-store fallback is a documented graceful path on Linux.
 */
async function checkSecretStore(ctx) {
  const platform = process.platform;
  if (platform === "darwin") {
    try {
      execFileSync("security", ["list-keychains", "-d", "user"], { stdio: "pipe", timeout: 3000 });
      return { status: "pass", label: "Secret store", detail: "macOS Keychain reachable" };
    } catch (err) {
      return {
        status: "fail",
        label: "Secret store",
        detail: `macOS \`security\` CLI failed: ${err?.message ?? "unknown"}`,
        hint: "macOS ships `security`; this should never fail. Check $PATH.",
      };
    }
  }
  if (platform === "linux") {
    try {
      execFileSync("secret-tool", ["--version"], { stdio: "pipe", timeout: 3000 });
      return { status: "pass", label: "Secret store", detail: "libsecret (`secret-tool`) reachable" };
    } catch {
      const hasMaster = !!process.env.PA_MASTER_PASSWORD;
      const keyfile = path.join(ctx.DATA_DIR, "secrets", ".master-key");
      const hasKeyfile = fs.existsSync(keyfile);
      if (hasMaster || hasKeyfile) {
        return {
          status: "pass",
          label: "Secret store",
          detail: hasMaster ? "file store with PA_MASTER_PASSWORD" : "file store with keyfile",
        };
      }
      return {
        status: "warn",
        label: "Secret store",
        detail: "no `secret-tool`, no PA_MASTER_PASSWORD, no keyfile",
        hint: "apt install libsecret-tools  · or set PA_MASTER_PASSWORD before first run (README §Linux setup)",
      };
    }
  }
  if (platform === "win32") {
    // Match the factory's terminal fallback (secret-client-factory.ts:37-41): prefer
    // in-box powershell.exe, else pwsh.exe, else default to powershell.exe — the exact
    // binary the daemon will exec — so a both-missing FAIL names the right binary.
    const psBinary = whichSync("powershell.exe") ? "powershell.exe" : (whichSync("pwsh.exe") ? "pwsh.exe" : "powershell.exe");
    try {
      // Mirror WindowsDpapiSecretClient's real encrypt path: ConvertTo/From-SecureString
      // (no -Key => DPAPI). Works on both powershell.exe (5.1) and pwsh.exe (7+); the prior
      // [ProtectedData] type check false-fails on PowerShell-Core-only hosts that work fine.
      execFileSync(psBinary, [
        "-NoProfile", "-NonInteractive", "-Command",
        "$s = ConvertTo-SecureString 'probe' -AsPlainText -Force; $e = ConvertFrom-SecureString $s; if (-not $e) { exit 1 }; exit 0",
      ], { stdio: "pipe", timeout: 5000 });
      return { status: "pass", label: "Secret store", detail: `Windows DPAPI via ${psBinary} reachable` };
    } catch (err) {
      return {
        status: "fail",
        label: "Secret store",
        detail: `PowerShell DPAPI probe failed: ${err?.message ?? "unknown"}`,
        hint: "PowerShell ships with Windows; check $PATH or install PowerShell 7+ (`pwsh.exe`).",
      };
    }
  }
  return {
    status: "warn",
    label: "Secret store",
    detail: `unknown platform ${platform}`,
    hint: "Supported: darwin, linux, win32. File a bug if your platform is reasonable.",
  };
}

async function checkBackendCli() {
  const candidates = ["claude", "codex", "gemini"];
  const found = [];
  for (const name of candidates) {
    if (whichSync(name)) found.push(name);
  }
  if (found.length > 0) {
    return { status: "pass", label: "Backend CLI", detail: `${found.join(", ")} on PATH` };
  }
  return {
    status: "warn",
    label: "Backend CLI",
    detail: "none of claude/codex/gemini found on PATH",
    hint: "Install at least one (Claude Code recommended). The setup wizard can guide you.",
  };
}

/**
 * Process-listing primitive — `pgrep` on POSIX, `tasklist` on Windows. The
 * Obsidian observer uses this to ask "is the desktop app currently open?"
 * before treating the vault as live (services/obsidian.ts). Warn (not fail)
 * because every other observer keeps working without it.
 */
async function checkProcessProbe() {
  const isWin = process.platform === "win32";
  const tool = isWin ? "tasklist" : "pgrep";
  if (whichSync(tool)) {
    return { status: "pass", label: "Process probe", detail: `${tool} on PATH` };
  }
  return {
    status: "warn",
    label: "Process probe",
    detail: `${tool} not on PATH`,
    hint: isWin
      ? "tasklist ships with Windows — check that %SystemRoot%\\System32 is on PATH."
      : process.platform === "linux"
        ? "apt install procps  · or equivalent for your distro."
        : "pgrep ships with macOS in-box; check $PATH.",
  };
}

/**
 * Browser opener used by `aitne open` and the auto-open after `aitne start`.
 * darwin → `open`, win32 → `cmd` (hosts the `start` builtin), linux → `xdg-open`.
 * Warn-only: nothing in the daemon depends on this; users can navigate to
 * the dashboard URL by hand if missing.
 */
async function checkBrowserOpener(dashboardPort) {
  const platform = process.platform;
  const tool =
    platform === "darwin" ? "open"
      : platform === "win32" ? "cmd"
        : "xdg-open";
  if (whichSync(tool)) {
    return { status: "pass", label: "Browser opener", detail: `${tool} on PATH` };
  }
  return {
    status: "warn",
    label: "Browser opener",
    detail: `${tool} not on PATH`,
    hint:
      platform === "linux"
        ? `apt install xdg-utils  · or open http://localhost:${dashboardPort} manually after \`aitne start\`.`
        : "Auto-open is a convenience; the dashboard URL works in any browser.",
  };
}

async function checkDataDirWritable(dataDir) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, `.doctor-probe-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return { status: "pass", label: "Data dir writable", detail: dataDir };
  } catch (err) {
    return {
      status: "fail",
      label: "Data dir writable",
      detail: `${dataDir}: ${err?.message ?? "unknown"}`,
      hint: "Check permissions on the parent directory, or set PA_DATA_DIR to a writable path.",
    };
  }
}

async function checkBetterSqlite3(projectRoot) {
  try {
    const { loadBetterSqlite3 } = await import("../lib/sqlite-loader.mjs");
    const Database = await loadBetterSqlite3(projectRoot);
    // Open an in-memory DB to exercise the native binding fully.
    const db = new Database(":memory:");
    db.close();
    return { status: "pass", label: "better-sqlite3", detail: "native binding loads" };
  } catch (err) {
    return {
      status: "fail",
      label: "better-sqlite3",
      detail: `failed to load: ${err?.message ?? "unknown"}`,
      hint: "Reinstall the package — your platform may have downloaded a corrupt prebuild. `pnpm rebuild better-sqlite3` from the dev repo.",
    };
  }
}

async function checkAgentAssets(projectRoot) {
  const skillsDir = path.join(projectRoot, "agent-assets", "skills");
  if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
    let entries = 0;
    try { entries = fs.readdirSync(skillsDir).length; } catch { /* permission edge */ }
    return { status: "pass", label: "agent-assets", detail: `${entries} skill(s) at ${skillsDir}` };
  }
  return {
    status: "fail",
    label: "agent-assets",
    detail: `missing: ${skillsDir}`,
    hint: "The package looks corrupt. Reinstall: `npm install -g aitne@latest`.",
  };
}

/**
 * Per-row drift check for unified repositories rows that pair a GitHub
 * remote with a local clone. Resolves `git -C <local_path> remote get-url
 * origin` and compares to the registered `<owner>/<repo>`. See
 * `docs/design/appendices/unified-repositories.md` §11.1 for the lock.
 *
 * Returns one check row per drifted (or origin-less) repository, plus a
 * single summary row when nothing drifts. The doctor is informational —
 * fixes happen via /api/repositories or the dashboard.
 */
async function checkRepositoryGithubLinkDrift(dataDir) {
  const dbPath = path.join(dataDir, "data", "personal_agent.db");
  if (!fs.existsSync(dbPath)) {
    return [
      {
        status: "pass",
        label: "Repository drift",
        detail: "no DB yet (skipped — run aitne start first)",
      },
    ];
  }

  // Lazy-load better-sqlite3 from the daemon package so doctor stays
  // dependency-light; if the native binding is missing we fall through
  // to a pass with a hint (rather than fail the whole doctor pass).
  let Database;
  try {
    const candidates = [
      path.join(process.cwd(), "node_modules", "better-sqlite3", "lib", "index.js"),
      path.join(process.cwd(), "packages", "daemon", "node_modules", "better-sqlite3", "lib", "index.js"),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      return [
        {
          status: "warn",
          label: "Repository drift",
          detail: "better-sqlite3 not resolvable from doctor — skipped",
          hint: "Run `pnpm install` in the repo, then re-run aitne doctor.",
        },
      ];
    }
    Database = (await import(found)).default ?? (await import(found));
  } catch (err) {
    return [
      {
        status: "warn",
        label: "Repository drift",
        detail: `better-sqlite3 load failed: ${err?.message ?? "unknown"}`,
        hint: "Re-run `pnpm install` to rebuild the native binding.",
      },
    ];
  }

  let rows;
  try {
    const db = new Database(dbPath, { readonly: true });
    rows = db
      .prepare(
        `SELECT id, github_owner, github_repo, local_path, display_name
           FROM repositories
          WHERE github_owner IS NOT NULL
            AND github_repo IS NOT NULL
            AND local_path IS NOT NULL
            AND local_only = 0`,
      )
      .all();
    db.close();
  } catch (err) {
    return [
      {
        status: "warn",
        label: "Repository drift",
        detail: `DB read failed: ${err?.message ?? "unknown"}`,
        hint: "Stop the daemon (aitne stop) and re-run, or check DB integrity.",
      },
    ];
  }

  if (rows.length === 0) {
    return [
      {
        status: "pass",
        label: "Repository drift",
        detail: "no GitHub-paired rows with a local clone",
      },
    ];
  }

  const drifted = [];
  for (const row of rows) {
    const expected = `${row.github_owner}/${row.github_repo}`;
    let originUrl = "";
    try {
      const out = execFileSync("git", ["-C", row.local_path, "remote", "get-url", "origin"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 3000,
      });
      originUrl = out.toString().trim();
    } catch {
      drifted.push({ row, expected, actual: null });
      continue;
    }
    const actual = parseGithubOwnerRepo(originUrl);
    if (!actual || actual.toLowerCase() !== expected.toLowerCase()) {
      drifted.push({ row, expected, actual });
    }
  }

  if (drifted.length === 0) {
    return [
      {
        status: "pass",
        label: "Repository drift",
        detail: `${rows.length} paired row(s) — origin matches`,
      },
    ];
  }

  return drifted.map(({ row, expected, actual }) => ({
    status: "warn",
    label: `Repository drift`,
    detail: `'${row.display_name ?? expected}' — registered ${expected}, origin ${actual ?? "(none)"}`,
    hint: `clone: ${row.local_path} — re-link to actual / mark local-only / unlink local clone via the dashboard`,
  }));
}

/**
 * Parse `<owner>/<repo>` out of a GitHub remote URL. Supports
 *   - https://github.com/owner/repo(.git)?
 *   - git@github.com:owner/repo(.git)?
 *   - ssh://git@github.com/owner/repo(.git)?
 * Returns null for non-GitHub remotes — the row's GitHub side is then
 * treated as unknown for drift purposes.
 */
function parseGithubOwnerRepo(url) {
  if (!url) return null;
  const trimmed = url.trim();
  const patterns = [
    /^https?:\/\/(?:[^/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

// ── helpers ──

/** Cross-platform `which` returning the resolved path or null. */
function whichSync(cmd) {
  const isWin = process.platform === "win32";
  const tool = isWin ? "where" : "which";
  try {
    const out = execFileSync(tool, [cmd], { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    const first = out.toString().split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}
