/**
 * `aitne update` — print the npm command to upgrade.
 *
 * No self-updater. Self-updaters break weirdly (permissions, registry
 * redirects, partial writes) and npm already solves this. We only emit
 * instructions; the user runs the command.
 *
 * Optional `--check` performs one short network call to compare against the
 * latest published version. Default behavior is offline so the command stays
 * fast and works on planes/trains.
 */
export async function run(args, ctx) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: aitne update [--check]

Print the command to upgrade ${ctx.APP_NAME}. Does not actually upgrade —
self-updaters fail in surprising ways, so the user runs the command.

Flags:
  --check        Make one network call to npm to fetch the latest version.
                 Without --check, this command is offline.`);
    return;
  }

  const cmd = `npm install -g ${packageNameForUpgrade()}@latest`;
  console.log(`${ctx.APP_NAME} v${ctx.VERSION} is installed.`);
  console.log("");
  console.log("To upgrade:");
  console.log("");
  console.log(`    ${cmd}`);
  console.log("");
  console.log("After the upgraded daemon starts, bundled templates, docs, skills, and");
  console.log("backend instruction caches are reconciled non-destructively. User-edited");
  console.log("files are preserved and surfaced in the dashboard for review.");
  console.log("");
  console.log("Or run a one-shot session without installing:");
  console.log("");
  console.log(`    npx ${packageNameForUpgrade()}@latest start`);

  if (args.includes("--check")) {
    const latest = await fetchLatestVersion(packageNameForUpgrade());
    if (latest) {
      const cmp = compareSemver(ctx.VERSION, latest);
      console.log("");
      if (cmp < 0) {
        console.log(`A newer version is available: ${latest} (current: ${ctx.VERSION}).`);
      } else if (cmp === 0) {
        console.log(`You are on the latest version (${latest}).`);
      } else {
        console.log(`You are ahead of the latest published version (${latest}).`);
      }
    } else {
      console.log("");
      console.log("(could not reach the npm registry — version check skipped)");
    }
  }
}

/**
 * The published package name on npm. Hardcoded here rather than read from
 * package.json so a maintainer who renames the in-repo package locally
 * doesn't accidentally direct users to the wrong upgrade target.
 */
function packageNameForUpgrade() {
  return "@aitne-sh/aitne";
}

async function fetchLatestVersion(name) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/** Tiny semver-ish comparator; returns -1 / 0 / 1. Pre-release tags ignored. */
function compareSemver(a, b) {
  const pa = a.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}
