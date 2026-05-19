/**
 * `aitne setup` — re-run the setup wizard.
 *
 * Equivalent to `aitne open --setup`, but exists as its own verb so users
 * who just want to (re)configure don't have to know about the `--setup`
 * flag. Both paths converge on /setup once the daemon is up.
 */
export async function run(args, ctx) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: aitne setup

Open the dashboard /setup wizard, auto-starting ${ctx.APP_NAME} first if
needed. Use this to (re)configure backends, integrations, plans, or
execution mode after the initial install.`);
    return;
  }
  // Delegate to open.mjs with --setup so the auto-start logic stays in one
  // place.
  const open = await import("./open.mjs");
  return open.run(["--setup", ...args.filter((a) => a !== "--setup")], ctx);
}
