/**
 * `aitne version` — print version and execution environment.
 *
 * Detail beyond a bare semver helps when triaging install issues remotely
 * ("what version of node, where is it installed, what platform?"). All of
 * this is local-only — no network calls. For "is there a newer version?"
 * use `aitne update` instead, which is opt-in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasPackagedBuild } from "../run-node.mjs";

export async function run(args, ctx) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: aitne version

Print version, Node version, install path, and platform.

This command is offline — to check for newer published versions, use
\`aitne update\`.`);
    return;
  }

  if (args.includes("--json")) {
    const payload = collectVersion(ctx);
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  const v = collectVersion(ctx);
  console.log(`${ctx.APP_NAME} v${v.version}`);
  console.log("");
  console.log(`  Node:        ${v.node}`);
  console.log(`  Platform:    ${v.platform} (${v.arch})`);
  console.log(`  Install:     ${v.installPath}`);
  console.log(`  Data dir:    ${v.dataDir}`);
  console.log(`  Build:       ${v.buildAt ?? (v.packagedBuild ? "packaged artifacts" : "(not built — run 'aitne build')")}`);
}

function collectVersion(ctx) {
  let buildAt = null;
  const stamp = path.join(ctx.PROJECT_ROOT, ".buildstamp");
  if (fs.existsSync(stamp)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stamp, "utf8"));
      if (parsed?.builtAt) buildAt = new Date(parsed.builtAt).toISOString();
    } catch { /* malformed stamp — treat as missing */ }
  }
  return {
    name: ctx.APP_NAME,
    version: ctx.VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    installPath: ctx.PROJECT_ROOT,
    dataDir: ctx.DATA_DIR,
    homeDir: os.homedir(),
    buildAt,
    packagedBuild: buildAt == null && hasPackagedBuild(ctx.PROJECT_ROOT),
  };
}
