/**
 * `aitne open` — open the dashboard in the user's browser.
 *
 * If the daemon isn't running, auto-starts it (so a single command takes the
 * user from "nothing running" to "dashboard tab open"). The auto-start path
 * deliberately suppresses the browser-open step inside `cmdStart` (`--no-open`)
 * because we open at the end of *this* command — otherwise the URL gets
 * opened twice on cold-start.
 */
export async function run(args, ctx) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: aitne open [--setup]

Open the dashboard in the default browser. Auto-starts the daemon if
it isn't running.

Flags:
  --setup        Open the /setup wizard route instead of the root page.`);
    return;
  }

  const goSetup = args.includes("--setup");
  const url = goSetup
    ? `http://localhost:${ctx.DASHBOARD_PORT}/setup`
    : `http://localhost:${ctx.DASHBOARD_PORT}/`;

  const daemonPid = ctx.helpers.getRunningPid(ctx.DAEMON_PID_FILE);
  const dashPid = ctx.helpers.getRunningPid(ctx.DASHBOARD_PID_FILE);

  if (!daemonPid || !dashPid) {
    console.log(`${ctx.APP_NAME} is not running — starting now…`);
    await ctx.helpers.cmdStart(["--no-open"]);
  }

  console.log(`Opening ${url}`);
  const opened = await ctx.helpers.openBrowser(url);
  if (!opened) {
    console.log("(could not auto-open browser — paste the URL above manually)");
  }
}
