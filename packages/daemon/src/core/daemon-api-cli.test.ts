import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDaemonApiCliEnv,
  DAEMON_API_BASE_URL_ENV,
  DAEMON_API_EVENT_CORRELATION_ID_ENV,
  DAEMON_API_EVENT_ID_ENV,
  DAEMON_API_PROCESS_KEY_ENV,
  DAEMON_API_READ_TOKEN_ENV,
  DAEMON_API_SESSION_BACKEND_ENV,
  DAEMON_API_SESSION_ID_ENV,
  ensureDaemonApiCli,
  SESSION_DAEMON_API_BIN_DIR,
  SESSION_DAEMON_API_CLI_REL_PATH,
  SESSION_DAEMON_CURL_SHIM_REL_PATH,
} from "./daemon-api-cli.js";

describe("daemon-api-cli", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("materializes daemon-managed helper binaries under .pa/bin", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-cli-"));
    tempDirs.push(sessionDir);

    const cliPath = ensureDaemonApiCli(sessionDir);
    const curlShimPath = join(sessionDir, SESSION_DAEMON_CURL_SHIM_REL_PATH);

    expect(cliPath).toBe(join(sessionDir, SESSION_DAEMON_API_CLI_REL_PATH));
    expect(existsSync(cliPath)).toBe(true);
    expect(existsSync(curlShimPath)).toBe(true);
    expect(readFileSync(cliPath, "utf-8")).toContain("PA_DAEMON_READ_TOKEN");
    const shimContent = readFileSync(curlShimPath, "utf-8");
    expect(shimContent).toContain("curl is restricted");
    expect(shimContent).toContain("x-turn-token");
    expect(shimContent).toContain("x-filename");
    expect(shimContent).toContain("x-caption");
    expect(shimContent).toContain('"-F"');
    expect(shimContent).toContain("FormData");
    expect(shimContent).toContain("process.env.PA_TURN_TOKEN");
    expect(shimContent).toContain('"/api/chat/outbound-attachments"');
    expect(shimContent).toContain("inferMimeFromName");
    expect(shimContent).toContain('"text/markdown"');
    expect(shimContent).toContain('"text/csv"');
    // Real curl 7.82+ shorthands the agent learns from skill prose. Without
    // these the shim used to fail with "Unsupported curl flag: --json" /
    // "--head" and burn budget on routine.morning_routine_today retries.
    expect(shimContent).toContain('"--json"');
    expect(shimContent).toContain('"--head"');
    expect(statSync(cliPath).mode & 0o777).toBe(0o700);
    expect(statSync(curlShimPath).mode & 0o777).toBe(0o700);
  });

  it("builds helper env with loopback base URL and optional read token", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-env-"));
    tempDirs.push(sessionDir);

    const withToken = buildDaemonApiCliEnv(sessionDir, 9000, "secret-token");
    expect(withToken[DAEMON_API_BASE_URL_ENV]).toBe("http://127.0.0.1:9000");
    expect(withToken[DAEMON_API_READ_TOKEN_ENV]).toBe("secret-token");
    expect(withToken.PATH?.split(":")[0]).toBe(join(sessionDir, ".pa/bin"));

    const withoutToken = buildDaemonApiCliEnv(sessionDir, 8321);
    expect(withoutToken[DAEMON_API_BASE_URL_ENV]).toBe("http://127.0.0.1:8321");
    expect(withoutToken[DAEMON_API_READ_TOKEN_ENV]).toBeUndefined();
    expect(withoutToken.PATH?.split(":")[0]).toBe(join(sessionDir, ".pa/bin"));
  });

  // SECURITY: the agent subprocess env is a copy of the daemon's process.env.
  // Agents run with bypassPermissions + Bash, so `env`/`printenv` can leak
  // anything in it. These tests pin the scrubbing of daemon-internal secrets
  // and inactive-backend provider keys.
  describe("sensitive-credential scrubbing", () => {
    function withEnv(
      vars: Record<string, string | undefined>,
      fn: () => void,
    ): void {
      const saved: Record<string, string | undefined> = {};
      for (const key of Object.keys(vars)) saved[key] = process.env[key];
      try {
        for (const [key, value] of Object.entries(vars)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        fn();
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }

    function freshSessionDir(): string {
      const dir = mkdtempSync(join(tmpdir(), "pa-daemon-api-env-"));
      tempDirs.push(dir);
      return dir;
    }

    it("never propagates PA_MASTER_PASSWORD to a child (active backend known)", () => {
      const sessionDir = freshSessionDir();
      withEnv({ PA_MASTER_PASSWORD: "super-secret-master" }, () => {
        const env = buildDaemonApiCliEnv(sessionDir, 8321, {
          sessionBackend: "claude",
        });
        expect(env.PA_MASTER_PASSWORD).toBeUndefined();
      });
    });

    it("strips PA_MASTER_PASSWORD but leaves provider keys when no backend is set", () => {
      const sessionDir = freshSessionDir();
      withEnv({ PA_MASTER_PASSWORD: "x", OPENAI_API_KEY: "sk-openai" }, () => {
        const env = buildDaemonApiCliEnv(sessionDir, 8321, {});
        expect(env.PA_MASTER_PASSWORD).toBeUndefined();
        // No backend known → provider-key scoping is skipped.
        expect(env.OPENAI_API_KEY).toBe("sk-openai");
      });
    });

    it("leaves provider keys when the backend id is unrecognised", () => {
      const sessionDir = freshSessionDir();
      withEnv({ PA_MASTER_PASSWORD: "x", OPENAI_API_KEY: "sk-openai" }, () => {
        const env = buildDaemonApiCliEnv(sessionDir, 8321, {
          sessionBackend: "not-a-real-backend",
        });
        expect(env.PA_MASTER_PASSWORD).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBe("sk-openai");
      });
    });

    it("scopes provider keys to the active backend (a Claude session gets no OpenAI/Gemini key)", () => {
      const sessionDir = freshSessionDir();
      withEnv(
        {
          ANTHROPIC_API_KEY: "sk-ant",
          OPENAI_API_KEY: "sk-openai",
          GEMINI_API_KEY: "g-key",
        },
        () => {
          const env = buildDaemonApiCliEnv(sessionDir, 8321, {
            sessionBackend: "claude",
          });
          expect(env.ANTHROPIC_API_KEY).toBe("sk-ant"); // active backend keeps its own
          expect(env.OPENAI_API_KEY).toBeUndefined(); // codex key stripped
          expect(env.GEMINI_API_KEY).toBeUndefined(); // gemini key stripped
        },
      );
    });

    it("keeps a credential shared by the active backend, strips the rest", () => {
      const sessionDir = freshSessionDir();
      // GOOGLE_APPLICATION_CREDENTIALS is managed by both gemini (vertex) and
      // claude (vertex). For a gemini session it must survive even though
      // claude is an inactive backend that also lists it.
      withEnv(
        {
          GOOGLE_APPLICATION_CREDENTIALS: "/path/to/creds.json",
          ANTHROPIC_API_KEY: "sk-ant",
          OPENAI_API_KEY: "sk-openai",
        },
        () => {
          const env = buildDaemonApiCliEnv(sessionDir, 8321, {
            sessionBackend: "gemini",
          });
          expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/path/to/creds.json");
          expect(env.ANTHROPIC_API_KEY).toBeUndefined();
          expect(env.OPENAI_API_KEY).toBeUndefined();
        },
      );
    });
  });

  // DELEGATED-MODE-V2-DESIGN.md §4.2.3 — delegated-endpoint env pathway
  describe("session-identity env vars (sessionBackend / eventId / processKey)", () => {
    it("emits PA_SESSION_BACKEND when options.sessionBackend is provided", () => {
      const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-env-"));
      tempDirs.push(sessionDir);
      const env = buildDaemonApiCliEnv(sessionDir, 8321, {
        sessionBackend: "claude",
      });
      expect(env[DAEMON_API_SESSION_BACKEND_ENV]).toBe("claude");
    });

    it("emits PA_EVENT_ID and PA_PROCESS_KEY when provided", () => {
      const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-env-"));
      tempDirs.push(sessionDir);
      const env = buildDaemonApiCliEnv(sessionDir, 8321, {
        sessionBackend: "codex",
        eventId: "evt-123",
        processKey: "message.dm",
      });
      expect(env[DAEMON_API_SESSION_BACKEND_ENV]).toBe("codex");
      expect(env[DAEMON_API_EVENT_ID_ENV]).toBe("evt-123");
      expect(env[DAEMON_API_PROCESS_KEY_ENV]).toBe("message.dm");
    });

    it("clears each PA_* identity var when option is omitted", () => {
      const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-env-"));
      tempDirs.push(sessionDir);
      const env = buildDaemonApiCliEnv(sessionDir, 8321, {});
      expect(env[DAEMON_API_SESSION_BACKEND_ENV]).toBeUndefined();
      expect(env[DAEMON_API_EVENT_ID_ENV]).toBeUndefined();
      expect(env[DAEMON_API_PROCESS_KEY_ENV]).toBeUndefined();
      expect(env[DAEMON_API_EVENT_CORRELATION_ID_ENV]).toBeUndefined();
      expect(env[DAEMON_API_SESSION_ID_ENV]).toBeUndefined();
    });

    // Notify-dedup pathway — eventCorrelationId is the env that the shim
    // auto-injects as `X-Pa-Event-Correlation-Id` on /api/notify calls.
    it("emits PA_EVENT_CORRELATION_ID when options.eventCorrelationId is provided", () => {
      const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-env-"));
      tempDirs.push(sessionDir);
      const env = buildDaemonApiCliEnv(sessionDir, 8321, {
        eventCorrelationId: "evt-corr-abc",
      });
      expect(env[DAEMON_API_EVENT_CORRELATION_ID_ENV]).toBe("evt-corr-abc");
    });

    it("clears PA_EVENT_CORRELATION_ID when eventCorrelationId is empty string", () => {
      const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-env-"));
      tempDirs.push(sessionDir);
      const env = buildDaemonApiCliEnv(sessionDir, 8321, {
        eventCorrelationId: "",
      });
      expect(env[DAEMON_API_EVENT_CORRELATION_ID_ENV]).toBeUndefined();
    });

    it("emits PA_SESSION_ID when options.sessionId is provided", () => {
      const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-env-"));
      tempDirs.push(sessionDir);
      const env = buildDaemonApiCliEnv(sessionDir, 8321, {
        sessionId: 321,
      });
      expect(env[DAEMON_API_SESSION_ID_ENV]).toBe("321");
    });

    it("the legacy string-token signature still works (backward-compat)", () => {
      const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-env-"));
      tempDirs.push(sessionDir);
      const env = buildDaemonApiCliEnv(sessionDir, 8321, "tok");
      expect(env[DAEMON_API_READ_TOKEN_ENV]).toBe("tok");
      expect(env[DAEMON_API_SESSION_BACKEND_ENV]).toBeUndefined();
    });
  });

  // DELEGATED-MODE-V2-DESIGN.md §4.2.3 — header allowlist + delegated-route auto-inject
  it("CLI shim allowlists x-session-backend / x-event-id / x-process-key", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-cli-"));
    tempDirs.push(sessionDir);
    ensureDaemonApiCli(sessionDir);
    const cliPath = join(sessionDir, SESSION_DAEMON_API_CLI_REL_PATH);
    const cliContent = readFileSync(cliPath, "utf-8");
    expect(cliContent).toContain("x-session-backend");
    expect(cliContent).toContain("x-event-id");
    expect(cliContent).toContain("x-process-key");
    expect(cliContent).toContain("PA_SESSION_BACKEND");
    expect(cliContent).toContain("/api/integrations/");
  });

  it("curl shim allowlists x-session-backend / x-event-id / x-process-key", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-cli-"));
    tempDirs.push(sessionDir);
    ensureDaemonApiCli(sessionDir);
    const shimPath = join(sessionDir, SESSION_DAEMON_CURL_SHIM_REL_PATH);
    const shimContent = readFileSync(shimPath, "utf-8");
    expect(shimContent).toContain("x-session-backend");
    expect(shimContent).toContain("x-event-id");
    expect(shimContent).toContain("x-process-key");
    expect(shimContent).toContain("PA_SESSION_BACKEND");
    expect(shimContent).toContain("/api/integrations/");
  });

  // Notify-dedup pathway — both shims must allowlist the header AND
  // contain the route-scoped auto-inject branch. Without these, calls
  // through `pa-api` (Claude tool-allowlist path) or `curl` (skill prose)
  // would never reach the dispatcher's markEventNotified hook.
  it("CLI shim allowlists x-pa-event-correlation-id and auto-injects on /api/notify", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-cli-"));
    tempDirs.push(sessionDir);
    ensureDaemonApiCli(sessionDir);
    const cliPath = join(sessionDir, SESSION_DAEMON_API_CLI_REL_PATH);
    const cliContent = readFileSync(cliPath, "utf-8");
    expect(cliContent).toContain("x-pa-event-correlation-id");
    expect(cliContent).toContain("x-pa-session-id");
    expect(cliContent).toContain("PA_EVENT_CORRELATION_ID");
    expect(cliContent).toContain("PA_SESSION_ID");
    expect(cliContent).toContain("/api/notify");
    // Pattern is anchored — sanity-check the regex literal instead of
    // executing it (executing would require eval-ing the shim source).
    expect(cliContent).toContain("NOTIFY_ROUTE_PATTERN");
  });

  it("curl shim allowlists x-pa-event-correlation-id and auto-injects on /api/notify", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-cli-"));
    tempDirs.push(sessionDir);
    ensureDaemonApiCli(sessionDir);
    const shimPath = join(sessionDir, SESSION_DAEMON_CURL_SHIM_REL_PATH);
    const shimContent = readFileSync(shimPath, "utf-8");
    expect(shimContent).toContain("x-pa-event-correlation-id");
    expect(shimContent).toContain("x-pa-session-id");
    expect(shimContent).toContain("PA_EVENT_CORRELATION_ID");
    expect(shimContent).toContain("PA_SESSION_ID");
    expect(shimContent).toContain("/api/notify");
    expect(shimContent).toContain("NOTIFY_ROUTE_PATTERN");
  });

  // CROSS_PLATFORM_AUDIT — env-home-temp-path-case-collision.
  // Windows env var names are case-insensitive at the OS level but
  // `process.env` preserves the OS casing (canonically `Path`). The spread
  // predicate must drop ANY pre-existing case-variant of PATH so the explicit
  // `PATH` key (with the session-local `.pa/bin` shim dir) is the sole PATH
  // key handed to child_process.spawn — otherwise the child can resolve the
  // original `Path` (no shim dir), bypassing the daemon-API curl chokepoint.
  //
  // The predicate reads `process.env` directly, so we simulate the Windows
  // casing by injecting a `Path` case-variant. On POSIX `process.env.Path` is
  // a distinct key from the real `PATH` (case-sensitive env), which is exactly
  // the duplicate the predicate must collapse; assertions below hold on both
  // OSes because they test the key-set, not the case-variant's VALUE (which
  // the function never reads — it builds pathParts from `process.env.PATH`).
  it("collapses case-variant PATH keys so the shim dir leads exactly one PATH", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pa-daemon-api-env-"));
    tempDirs.push(sessionDir);

    const hadPath = Object.prototype.hasOwnProperty.call(process.env, "Path");
    const savedPath = process.env.Path;
    try {
      // A stray case-variant that the OLD predicate would leak through.
      process.env.Path = "C:/should-not-leak";
      const env = buildDaemonApiCliEnv(sessionDir, 8321);

      // (a) exactly one key whose uppercase form is PATH
      expect(
        Object.keys(env).filter((k) => k.toUpperCase() === "PATH").length,
      ).toBe(1);
      // (b) it is the canonical `PATH`; the case-variant `Path` is dropped
      expect(env.Path).toBeUndefined();
      expect(env.PATH).toBeDefined();
      // the leaked value must never become the surviving PATH
      expect(env.PATH).not.toContain("C:/should-not-leak");
      // (c) the session-local shim dir still leads
      expect(env.PATH?.split(delimiter)[0]).toBe(
        join(sessionDir, SESSION_DAEMON_API_BIN_DIR),
      );
      // (d) no PATH data loss — the canonical system path is appended after
      // the shim dir (when the host actually has a PATH set).
      if (process.env.PATH) {
        expect(env.PATH?.split(delimiter).slice(1).join(delimiter)).toBe(
          process.env.PATH,
        );
      }
    } finally {
      if (hadPath) {
        process.env.Path = savedPath;
      } else {
        delete process.env.Path;
      }
    }
  });
});
