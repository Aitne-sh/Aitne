import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextRoutes } from "./index.js";
import { applySchema } from "../../../db/schema.js";
import type { AgentConfig } from "../../../config.js";

/**
 * Audit B5 — route-level wiring for the prompt-quality lint. The lint LOGIC is
 * unit-tested in `core/agents/validate-agent-md.test.ts`; this proves the
 * non-blocking `warnings` array actually flows through a real agent.md write on
 * the context-vault PUT path (the recommended edit path), so an operator editing
 * `agent.md` gets the same authoring feedback the POST /api/agents create path
 * gives. Regression guard for the `agentMdWriteWarnings` spread in write.ts.
 */

function makeConfig(dataDir: string): AgentConfig {
  return { dataDir, executeTimeoutMinutes: 60 } as unknown as AgentConfig;
}

const SLUG = "say-hi";

function agentMarkdown(opts: { body: string; playbooks?: readonly string[] }): string {
  return [
    "---",
    `slug: ${SLUG}`,
    "name: Say Hi",
    "description: A friendly greeting agent.",
    "kind: user",
    "schedule:",
    "  kind: cron",
    '  expression: "0 9 * * *"',
    "backend:",
    "  process_key: agent.task",
    "limits:",
    "  max_turns: 5",
    "  max_budget_usd: 0.1",
    "  timeout_minutes: 5",
    ...(opts.playbooks ? ["playbooks:", ...opts.playbooks.map((p) => `  - ${p}`)] : []),
    "---",
    "",
    opts.body,
    "",
  ].join("\n");
}

describe("context write — agent.md prompt-quality lint warnings (audit B5)", () => {
  let dataDir: string;
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-b5-route-"));
    mkdirSync(join(dataDir, "context", "policies", "agents", SLUG), {
      recursive: true,
    });
    db = new Database(":memory:");
    applySchema(db);
    const routes = createContextRoutes({
      db,
      config: makeConfig(dataDir),
      onIndexableContextChange: () => {},
    } as unknown as Parameters<typeof createContextRoutes>[0]);
    app = new Hono();
    app.route("/api", routes);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function putAgentMd(content: string): Promise<Response> {
    return await app.request(`/api/context/policies/agents/${SLUG}/agent.md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  }

  it("surfaces a NON-blocking warning when the prompt names a playbook it does not declare", async () => {
    const res = await putAgentMd(
      agentMarkdown({
        body: "# Say Hi\n\nFollow the research playbook when gathering context.",
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      status: string;
      warnings?: { code: string; playbook?: string }[];
    };
    expect(data.status).toBe("updated");
    expect(
      data.warnings?.some(
        (w) =>
          w.code === "playbook_referenced_not_declared" &&
          w.playbook === "research",
      ),
    ).toBe(true);
  });

  it("omits the warnings key for a clean agent.md (byte-identical to the pre-B5 shape)", async () => {
    const res = await putAgentMd(
      agentMarkdown({
        body: "# Say Hi\n\nSend a friendly greeting.",
        playbooks: ["research"],
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; warnings?: unknown };
    expect(data.status).toBe("updated");
    expect(data.warnings).toBeUndefined();
  });

  it("still 400s a schema-invalid agent.md — the lint runs only on the success side, never as a 400", async () => {
    const invalid = agentMarkdown({ body: "# x\n\ny" }).replace(
      "name: Say Hi\n",
      "",
    );
    const res = await putAgentMd(invalid);
    expect(res.status).toBe(400);
  });
});
