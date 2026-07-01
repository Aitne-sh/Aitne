import { describe, test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

import { BACKEND_IDS, type BackendModel } from "@aitne/shared";

import { getModelsForBackend } from "./backends/model-registry.js";
import { readTreeFiles } from "./skills-compiler-tree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../");

/**
 * Agent-facing prompt surfaces hard-code concrete model ids as copy-me
 * examples (e.g. `claude-opus-4-8`, `gpt-5.4`, `"model": "claude-opus-4-8"`).
 * Those ids drift the moment MODEL_REGISTRY retires a generation (Sonnet 4.6 →
 * Sonnet 5), so rather than hand-editing every prompt on each registry bump,
 * this derives the valid, non-deprecated id set from MODEL_REGISTRY and fails
 * the build when a surface still names a deprecated / unknown id — naming the
 * current replacement so the fix is a one-line find-replace.
 *
 * Scope boundary — INCLUDES agent instructions, EXCLUDES reference docs:
 *  - `agent-assets/skills/**` + `agent-assets/task-flows/**` are what the agent
 *    is told to *do*; a model id named here is a "use this" example that must
 *    stay current. (Every concrete id in the skill corpus lives under the
 *    `schedule` skill; task-flows add the morning-routine / roadmap examples.)
 *  - `agent-assets/docs/**` is reference documentation that legitimately names
 *    *legacy* ids where a real constraint requires it — e.g.
 *    `docs/reference/config.md` documents that the advisor SDK is pinned to
 *    `claude-sonnet-4-6` / `claude-opus-4-6` ONLY (newer Opus is silently
 *    skipped). Guarding docs would false-fail on that intentional legacy pin,
 *    so docs are deliberately out of scope.
 */
const GUARDED_ROOTS = [
  join(REPO_ROOT, "agent-assets/skills"),
  join(REPO_ROOT, "agent-assets/task-flows"),
];

/**
 * Backtick- OR double-quote-wrapped, backend-model-id-shaped tokens as they
 * appear in prose and JSON examples: bare `claude-*` / `gpt-*` / `gemini-*`,
 * opencode's provider-prefixed `anthropic/*`, and `<backendId>/<modelId>`
 * composite disambiguators. Delimiter-bounded so it never matches a substring
 * of ordinary prose; the stable aliases (`sonnet` / `opus`) and tier words
 * (`lite` / `medium` / `high`) are not model ids and are intentionally unmatched.
 */
const MODEL_ID_TOKEN_RE =
  /[`"]((?:claude|gpt|gemini)-[a-z0-9][a-z0-9.-]*|(?:anthropic|claude|codex|gemini|opencode)\/[a-z0-9][a-z0-9./-]*)[`"]/g;

function allRegisteredModels(): BackendModel[] {
  return BACKEND_IDS.flatMap((backendId) => [...getModelsForBackend(backendId)]);
}

/** Strip a composite `<backendId>/` disambiguator prefix, if present. */
function stripCompositePrefix(token: string): string {
  const slash = token.indexOf("/");
  if (slash === -1) return token;
  const prefix = token.slice(0, slash);
  if ((BACKEND_IDS as readonly string[]).includes(prefix)) {
    return token.slice(slash + 1);
  }
  return token;
}

/** token -> ["<repo-rel path>:<line>", …] for every model id in the surfaces. */
function collectReferencedModelIds(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const root of GUARDED_ROOTS) {
    const rootRel = relative(REPO_ROOT, root);
    for (const file of readTreeFiles(root)) {
      if (!file.path.endsWith(".md")) continue;
      file.content.split("\n").forEach((line, i) => {
        for (const match of line.matchAll(MODEL_ID_TOKEN_RE)) {
          const token = match[1];
          const where = `${rootRel}/${file.path}:${i + 1}`;
          found.set(token, [...(found.get(token) ?? []), where]);
        }
      });
    }
  }
  return found;
}

describe("agent-facing prompt surfaces name only current MODEL_REGISTRY ids", () => {
  test("every concrete model id in agent-assets/{skills,task-flows} is a current, non-deprecated registry id", () => {
    const models = allRegisteredModels();
    const valid = new Set(models.filter((m) => !m.deprecated).map((m) => m.modelId));
    const known = new Set(models.map((m) => m.modelId));
    const referenced = collectReferencedModelIds();

    // Guard against a regex regression silently passing the whole test.
    expect(referenced.size).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const [token, occurrences] of referenced) {
      const resolved = stripCompositePrefix(token);
      if (valid.has(token) || valid.has(resolved)) continue;

      const entry = models.find((m) => m.modelId === token || m.modelId === resolved);
      const replacement = entry
        ? models.find((m) => m.backendId === entry.backendId && m.tier === entry.tier && !m.deprecated)
        : undefined;

      const reason = known.has(token) || known.has(resolved)
        ? `\`${token}\` is DEPRECATED in MODEL_REGISTRY${replacement ? ` → use \`${replacement.modelId}\`` : ""}`
        : `\`${token}\` is not a registered model id in MODEL_REGISTRY`;

      failures.push(`${reason}. Seen at: ${occurrences.join(", ")}.`);
    }

    expect(
      failures,
      `agent-facing prompt(s) name stale model id(s):\n${failures.join("\n")}\n` +
        `Valid non-deprecated ids: ${[...valid].sort().join(", ")}`,
    ).toEqual([]);
  });
});
