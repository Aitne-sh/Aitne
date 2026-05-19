/**
 * `aitne uninstall` — stop services and print the npm uninstall command.
 *
 * We do not run `npm uninstall -g aitne` ourselves: doing so from a process
 * the user is currently executing (the bin lives inside the package being
 * removed) is asking for partial writes and confusing error states. Instead,
 * stop cleanly, optionally wipe the data dir on explicit confirmation, then
 * print the command for the user to copy-paste.
 *
 * The data-dir wipe is gated behind a literal "WIPE" confirmation so a fat
 * finger doesn't lose months of context/. Mirrors the safety pattern used by
 * `aitne restart --clean-context`.
 */
import fs from "node:fs";
import path from "node:path";

export async function run(args, ctx) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: aitne uninstall [--keep-data] [--wipe-data]

Stops the daemon and dashboard, then prints the npm command to remove the
binary. Offers to wipe the data directory.

Flags:
  --keep-data    Skip the data-wipe prompt; leave ~/.personal-agent intact.
  --wipe-data    Skip the confirmation prompt; wipe the data dir non-interactively.
                 (Both flags together is an error.)`);
    return;
  }

  const keepData = args.includes("--keep-data");
  const wipeData = args.includes("--wipe-data");
  if (keepData && wipeData) {
    console.error("--keep-data and --wipe-data are mutually exclusive.");
    process.exit(1);
  }

  // Stop first — calling cmdStop here keeps the lifecycle logic in one place.
  const daemonPid = ctx.helpers.getRunningPid(ctx.DAEMON_PID_FILE);
  const dashPid = ctx.helpers.getRunningPid(ctx.DASHBOARD_PID_FILE);
  if (daemonPid || dashPid) {
    console.log(`Stopping ${ctx.APP_NAME}…`);
    await ctx.helpers.cmdStop();
  } else {
    console.log(`${ctx.APP_NAME} is not running.`);
  }

  // Prompt (or skip) for data wipe.
  const dataInfo = describeDataDir(ctx.DATA_DIR);
  let willWipe = false;
  if (!keepData) {
    if (wipeData) {
      willWipe = true;
    } else if (dataInfo.exists) {
      console.log("");
      console.log(`Data directory: ${ctx.DATA_DIR}  (${dataInfo.fileCount} files, ${dataInfo.sizeMb.toFixed(1)} MB)`);
      console.log("Type WIPE to also delete the data directory, anything else to keep it:");
      const reply = await readLineFromStdin();
      willWipe = reply.trim() === "WIPE";
    }
  }

  if (willWipe) {
    if (dataInfo.exists) {
      fs.rmSync(ctx.DATA_DIR, { recursive: true, force: true });
      console.log(`Wiped → ${ctx.DATA_DIR}`);
    } else {
      console.log("Data directory does not exist; nothing to wipe.");
    }
  } else if (!keepData && dataInfo.exists) {
    console.log(`Kept ${ctx.DATA_DIR} (${dataInfo.sizeMb.toFixed(1)} MB).`);
  }

  console.log("");
  console.log("To remove the binary, run:");
  console.log("");
  console.log("    npm uninstall -g aitne");
  console.log("");
  console.log("(We don't run this for you — npm handles uninstalling a global");
  console.log("package more reliably than a process executing from inside it.)");
}

function describeDataDir(dir) {
  if (!fs.existsSync(dir)) return { exists: false, fileCount: 0, sizeMb: 0 };
  let fileCount = 0;
  let totalBytes = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        fileCount++;
        try { totalBytes += fs.statSync(full).size; } catch { /* race — ignore */ }
      }
    }
  };
  walk(dir);
  return { exists: true, fileCount, sizeMb: totalBytes / (1024 * 1024) };
}

function readLineFromStdin() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    const onData = (chunk) => {
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      resolve(chunk);
    };
    process.stdin.on("data", onData);
  });
}
