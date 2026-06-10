import { describe, expect, it } from "vitest";
import type { IntegrationKey, IntegrationState } from "@aitne/shared";
import {
  buildAcquisitionPlan,
  buildAcquisitionPlanAssembly,
  buildAcquisitionTimestamps,
  splitAcquisitionPlanByIntegration,
  substituteAcquisitionTokens,
} from "./routine-acquisition-plan.js";

const FIXED_NOW = new Date("2026-05-11T13:42:30.000Z");

function state(
  partial: Partial<IntegrationState> & { mode: IntegrationState["mode"] },
): IntegrationState {
  return {
    delegatedBackend: null,
    nativeBackend: null,
    deniedTools: [],
    lastChangedAt: "2026-05-11T00:00:00.000Z",
    ...partial,
  } as IntegrationState;
}

describe("buildAcquisitionTimestamps", () => {
  it("anchors day_start to the agent-day boundary in the given timezone", () => {
    const ts = buildAcquisitionTimestamps(FIXED_NOW, "UTC", 0);
    expect(ts.day_start_iso).toBe("2026-05-11T00:00:00.000Z");
    expect(ts.day_end_iso).toBe("2026-05-12T00:00:00.000Z");
    expect(ts.day_plus_24h).toBe(ts.day_end_iso);
    expect(ts.day_plus_48h).toBe("2026-05-13T00:00:00.000Z");
  });

  it("rounds hour_start down to the hour", () => {
    const ts = buildAcquisitionTimestamps(FIXED_NOW, "UTC", 0);
    expect(ts.hour_start_iso).toBe("2026-05-11T13:00:00.000Z");
  });

  it("computes weekly / monthly horizons relative to day_start", () => {
    const ts = buildAcquisitionTimestamps(FIXED_NOW, "UTC", 0);
    expect(ts.week_end_iso).toBe("2026-05-18T00:00:00.000Z");
    expect(ts.month_end_iso).toBe("2026-06-10T00:00:00.000Z");
  });

  it("anchors iso_week_start to the current ISO week's Monday 00:00 local", () => {
    // 2026-05-11 is a Monday (ISO 2026-W20). FIXED_NOW falls on that Monday.
    const ts = buildAcquisitionTimestamps(FIXED_NOW, "UTC", 0);
    expect(ts.iso_week_start_iso).toBe("2026-05-11T00:00:00.000Z");
    expect(ts.iso_week_start_date).toBe("2026-05-11");
  });

  it("rolls iso_week_start back to Monday when the run lands mid-week", () => {
    // 2026-05-15 is the Friday of ISO 2026-W20; iso_week_start should
    // still be 2026-05-11 (the Monday of the same ISO week).
    const friday = new Date("2026-05-15T10:00:00.000Z");
    const ts = buildAcquisitionTimestamps(friday, "UTC", 0);
    expect(ts.iso_week_start_iso).toBe("2026-05-11T00:00:00.000Z");
    expect(ts.iso_week_start_date).toBe("2026-05-11");
  });

  it("respects the timezone when resolving Monday 00:00 to UTC", () => {
    // JST = UTC+9. Mon 00:00 JST = previous Sun 15:00 UTC.
    // FIXED_NOW (2026-05-11 13:42 UTC = 2026-05-11 22:42 JST) is still
    // Monday in JST → iso_week_start anchor stays at the local Mon 00:00.
    const ts = buildAcquisitionTimestamps(FIXED_NOW, "Asia/Tokyo", 4);
    expect(ts.iso_week_start_iso).toBe("2026-05-10T15:00:00.000Z");
    expect(ts.iso_week_start_date).toBe("2026-05-10");
  });

  it("computes day_plus_2h relative to now (not day_start)", () => {
    const ts = buildAcquisitionTimestamps(FIXED_NOW, "UTC", 0);
    expect(ts.day_plus_2h).toBe("2026-05-11T15:42:30.000Z");
  });

  it("emits date-only tokens for the calendar REST routes that take date+days", () => {
    // `/api/calendar/events` and `/api/calendar/outlook/events` parse
    // `date=YYYY-MM-DD`; the ISO datetime tokens are wrong for those
    // routes. The date-only variants must therefore match the UTC date
    // portion of their ISO sibling — not a re-shift into local time,
    // because the REST routes parse the date in UTC themselves.
    const ts = buildAcquisitionTimestamps(FIXED_NOW, "UTC", 0);
    expect(ts.day_start_date).toBe("2026-05-11");
    expect(ts.now_date).toBe("2026-05-11");
  });
});

describe("substituteAcquisitionTokens", () => {
  const ts = buildAcquisitionTimestamps(FIXED_NOW, "UTC", 0);

  it("substitutes every known token", () => {
    expect(substituteAcquisitionTokens("a={now_iso}&b={day_start_iso}", ts))
      .toBe(`a=${ts.now_iso}&b=${ts.day_start_iso}`);
  });

  it("leaves unknown tokens verbatim (visible failure)", () => {
    expect(substituteAcquisitionTokens("hello {does_not_exist} world", ts))
      .toBe("hello {does_not_exist} world");
  });
});

describe("buildAcquisitionPlan", () => {
  const ts = buildAcquisitionTimestamps(FIXED_NOW, "UTC", 0);
  const baseInput = {
    agentDay: "2026-05-11" as const,
    sessionBackend: "claude" as const,
    timestamps: ts,
  };

  it("wraps every plan in an <acquisition-plan> block, even when no rows survive", () => {
    const plan = buildAcquisitionPlan({
      ...baseInput,
      routine: "routine.monthly_review",
      integrations: {},
      accounts: [],
    });
    expect(plan).toContain('<acquisition-plan routine="monthly_review"');
    expect(plan).toContain("</acquisition-plan>");
    expect(plan).not.toContain("<fetch ");
  });

  it("emits one <fetch> per active mail account in direct mode (perAccount fan-out)", () => {
    const plan = buildAcquisitionPlan({
      ...baseInput,
      routine: "routine.morning_routine",
      integrations: {
        gmail: state({ mode: "direct" }),
        notion: state({ mode: "disabled" }),
      },
      accounts: [
        { integration: "gmail", accountId: "acc1", label: "a@x.test" },
        { integration: "gmail", accountId: "acc2", label: "b@x.test" },
      ],
    });
    const fetches = plan.match(/<fetch /g) ?? [];
    expect(fetches.length).toBe(2);
    expect(plan).toContain('integration="gmail"');
    expect(plan).toContain('mode="direct"');
    expect(plan).toContain('account="acc1"');
    expect(plan).toContain('account="acc2"');
    expect(plan).toContain('label="a@x.test"');
    expect(plan).toContain('window="inbox_today"');
  });

  it("skips integrations whose state is disabled", () => {
    const plan = buildAcquisitionPlan({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        gmail: state({ mode: "disabled" }),
        google_calendar: state({ mode: "direct" }),
        notion: state({ mode: "disabled" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    expect(plan).not.toContain('integration="gmail"');
    expect(plan).toContain('integration="google_calendar"');
    expect(plan).not.toContain('integration="notion"');
  });

  it("resolves delegated mode to delegated-same when delegatedBackend matches the session backend", () => {
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        gmail: state({ mode: "delegated", delegatedBackend: "claude" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    expect(plan).toContain('mode="delegated-same"');
    expect(plan).not.toContain('mode="delegated-cross"');
  });

  it("resolves delegated mode to delegated-cross when delegatedBackend differs from the session backend", () => {
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        gmail: state({ mode: "delegated", delegatedBackend: "codex" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    expect(plan).toContain('mode="delegated-cross"');
  });

  it("collapses delegated-cross to delegated-same for userManagedConnector integrations (no daemon proxy)", () => {
    // §6.8 / §3 glossary — outlook_mail / outlook_calendar have
    // `userManagedConnector: true` and no `/api/integrations/<key>/exec`
    // proxy. Even when the delegated binding points at a different
    // backend, the dispatcher must emit `delegated-same` so the partial
    // body's main delegated-same prose runs (the user's own MCP). The
    // delegated-cross row in the partial is a defensive fallback only;
    // it should never fire in practice.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        outlook_mail: state({ mode: "delegated", delegatedBackend: "codex" }),
      },
      accounts: [{ integration: "outlook_mail", accountId: "acc1" }],
    });
    expect(plan).toContain('mode="delegated-same"');
    expect(plan).not.toContain('mode="delegated-cross"');
  });

  it("emits native rows even when nativeBackend differs from the default session backend (per-integration backend routing)", () => {
    // Structural fix: native bindings whose `nativeBackend` differs from
    // the pre-pass default backend are NO LONGER silently dropped. They
    // emit as `mode="native"` and the runner spawns the sub-session on
    // `state.nativeBackend` via `BackendRouter.resolveBinding({
    // requestedBackendId })`. The previous silent-drop behavior had the
    // routine run with an empty observations table whenever the operator's
    // native binding didn't match the pre-pass default backend.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        gmail: state({ mode: "native", nativeBackend: "codex" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    expect(plan).toMatch(/integration="gmail"[^>]*mode="native"/);
    // Native query selection: must use the MCP-shape query, not the REST
    // form. Same invariant as the same-backend native test below.
    expect(plan).toContain('q="newer_than:1d -category:promotions -category:social"');
    expect(plan).not.toMatch(/query='\?since=/);
    // Per-account fan-out is direct-only; native rows must NOT inherit
    // stale account ids even when accounts[] carries them.
    expect(plan).not.toContain("account=");
  });

  it("keeps native rows whose nativeBackend matches the session backend", () => {
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        gmail: state({ mode: "native", nativeBackend: "claude" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    expect(plan).toContain('mode="native"');
    expect(plan).toContain('integration="gmail"');
    // A8 (2026-05-13) — perAccount is direct-only. Even though `accounts`
    // carries `acc1`, the native row MUST NOT inherit it. Stale
    // mail_accounts rows from a prior direct-mode deployment would
    // otherwise contaminate native observations with a fabricated
    // accountId after a mode flip.
    expect(plan).not.toContain("account=");
    // Mode-keyed query selection: native must emit the MCP-shape query,
    // not the REST-shape one. Without this assertion, swapping
    // `lookupQuery`'s mode branch could silently regress.
    expect(plan).toContain('q="newer_than:1d -category:promotions -category:social"');
    expect(plan).not.toMatch(/query='\?since=/);
  });

  // Mixed-mode coverage. A real deployment may have gmail bound native,
  // google_calendar delegated to a different backend, notion direct, and
  // outlook_mail user-managed delegated all in the same install. Verify
  // the plan emits each row with the correct mode attribute so the
  // partials filter to the right branch.
  describe("mixed native + delegated + direct in one routine", () => {
    it("session=codex, gmail=native(codex) + google_calendar=delegated(claude) + notion=direct", () => {
      const plan = buildAcquisitionPlan({
        ...baseInput,
        sessionBackend: "codex",
        routine: "routine.morning_routine",
        integrations: {
          gmail: state({ mode: "native", nativeBackend: "codex" }),
          google_calendar: state({ mode: "delegated", delegatedBackend: "claude" }),
          notion: state({ mode: "direct" }),
        },
        accounts: [{ integration: "gmail", accountId: "acc1" }],
      });
      expect(plan).toMatch(/integration="gmail"[^>]*mode="native"/);
      expect(plan).toMatch(
        /integration="google_calendar"[^>]*mode="delegated-cross"/,
      );
      expect(plan).toMatch(/integration="notion"[^>]*mode="direct"/);
    });

    it("session=claude, gmail=delegated(codex) + google_calendar=native(claude) + notion=disabled", () => {
      const plan = buildAcquisitionPlan({
        ...baseInput,
        sessionBackend: "claude",
        routine: "routine.morning_routine",
        integrations: {
          gmail: state({ mode: "delegated", delegatedBackend: "codex" }),
          google_calendar: state({ mode: "native", nativeBackend: "claude" }),
          notion: state({ mode: "disabled" }),
        },
        accounts: [{ integration: "gmail", accountId: "acc1" }],
      });
      expect(plan).toMatch(/integration="gmail"[^>]*mode="delegated-cross"/);
      expect(plan).toMatch(
        /integration="google_calendar"[^>]*mode="native"/,
      );
      expect(plan).not.toContain('integration="notion"');
    });

    // Per-backend matrix: for every backend that can host the session,
    // a native binding on the SAME backend lands as mode="native" and a
    // delegated binding to a DIFFERENT backend lands as
    // mode="delegated-cross". This guards against a future backend
    // (e.g., opencode) joining the matrix without the plan resolver
    // being taught about it.
    for (const sessionBackend of ["claude", "codex", "gemini", "opencode"] as const) {
      const otherBackend = sessionBackend === "claude" ? "codex" : "claude";
      it(`session=${sessionBackend}: native(${sessionBackend}) and delegated(${otherBackend}) co-exist`, () => {
        const plan = buildAcquisitionPlan({
          ...baseInput,
          sessionBackend,
          routine: "routine.morning_routine",
          integrations: {
            gmail: state({ mode: "native", nativeBackend: sessionBackend }),
            google_calendar: state({ mode: "delegated", delegatedBackend: otherBackend }),
          },
          accounts: [{ integration: "gmail", accountId: "acc1" }],
        });
        expect(plan).toMatch(/integration="gmail"[^>]*mode="native"/);
        expect(plan).toMatch(
          /integration="google_calendar"[^>]*mode="delegated-cross"/,
        );
      });
    }

    // The reverse split — delegated bound to the same backend
    // (delegated-same) and native bound to a DIFFERENT backend —
    // exercises the per-integration backend routing fix. Pre-fix the
    // native row was silently filtered; post-fix it survives because
    // the runner will spawn it on `nativeBackend` rather than the
    // default `sessionBackend`.
    it("session=codex: delegated-same(codex) co-exists with native(claude) routed to claude sub-session", () => {
      const plan = buildAcquisitionPlan({
        ...baseInput,
        sessionBackend: "codex",
        routine: "routine.morning_routine",
        integrations: {
          gmail: state({ mode: "delegated", delegatedBackend: "codex" }),
          google_calendar: state({ mode: "native", nativeBackend: "claude" }),
        },
        accounts: [{ integration: "gmail", accountId: "acc1" }],
      });
      expect(plan).toMatch(/integration="gmail"[^>]*mode="delegated-same"/);
      // google_calendar native row survives — sub-session will spawn on
      // `state.nativeBackend` (claude) via the runner's per-integration
      // backend routing.
      expect(plan).toMatch(
        /integration="google_calendar"[^>]*mode="native"/,
      );
    });
  });

  it("substitutes timestamp tokens into the emitted query attribute", () => {
    const plan = buildAcquisitionPlan({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        gmail: state({ mode: "direct" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    // `unread_last_hour` for gmail direct = "?since={hour_start_iso}&unreadOnly=true&limit=10"
    expect(plan).toContain(`since=${ts.hour_start_iso}`);
    expect(plan).not.toMatch(/since=\{hour_start_iso\}/);
  });

  it("keeps query-string ampersands AND double-quotes unescaped (single-quoted query attribute)", () => {
    // The block's consumer is the LLM, not an XML parser. The partial
    // body tells it to append the `query` attribute to the daemon URL
    // verbatim, or pass it directly as MCP-tool args. Two characters
    // would otherwise need entity-decode steps the agent must
    // remember:
    //   - `&` separates URL query parameters (?a=1&b=2)
    //   - `"` wraps Gmail / Calendar MCP query expressions
    //     (q="newer_than:1d", timeMin="…")
    // Routing the query through `xmlQueryAttr` + single-quote
    // delimiter keeps both literal.

    // (1) URL-shape query: `?since=…&unreadOnly=true&limit=10`
    const direct = buildAcquisitionPlan({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        outlook_mail: state({ mode: "direct" }),
      },
      accounts: [{ integration: "outlook_mail", accountId: "acc1" }],
    });
    expect(direct).toContain("&unreadOnly=true");
    expect(direct).toContain("&limit=10");
    expect(direct).not.toContain("&amp;");

    // (2) MCP-shape query containing literal `"`:
    //     `q="is:unread newer_than:1h" maxResults=10`
    const delegated = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.hourly_check",
      integrations: {
        gmail: state({ mode: "delegated", delegatedBackend: "claude" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    expect(delegated).toContain('q="is:unread newer_than:1h -category:promotions -category:social"');
    expect(delegated).not.toContain("&quot;");

    // The `query=` attribute itself must use single-quote delimiters so
    // the embedded `"` doesn't terminate the attribute value.
    expect(delegated).toMatch(/query='[^']*'/);
    // No `<` / `>` should ever appear in the query payload today, but
    // if a future catalog author uses them they'd still escape.
    expect(delegated).not.toMatch(/query='[^']*<[^']*'/);
  });

  it("substitutes date-only tokens into calendar REST queries that use date+days", () => {
    // The cataloged direct-mode query for `imminent_2h` on
    // google_calendar uses `?date={now_date}&days=1` — the REST route
    // accepts date+days, not timeMin/timeMax. The assembly helper must
    // emit the date-only token; an unsubstituted `{now_date}` here would
    // mean every direct-mode calendar fetch silently asks for date=
    // `{now_date}` and hits the daemon's "invalid date format" branch.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        google_calendar: state({ mode: "direct" }),
      },
      accounts: [],
    });
    expect(plan).toContain(`date=${ts.now_date}`);
    expect(plan).not.toMatch(/date=\{now_date\}/);
  });

  it("emits one row per non-perAccount window (calendar / notion) regardless of account count", () => {
    const plan = buildAcquisitionPlan({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        google_calendar: state({ mode: "direct" }),
        outlook_calendar: state({ mode: "direct" }),
        notion: state({ mode: "direct" }),
      },
      accounts: [],
    });
    const fetches = plan.match(/<fetch /g) ?? [];
    expect(fetches.length).toBe(3);
    expect(plan).toContain('integration="google_calendar"');
    expect(plan).toContain('integration="outlook_calendar"');
    expect(plan).toContain('integration="notion"');
  });

  it("omits rows whose (symbol, integration, mode) cell is unmapped (no silent emission)", () => {
    // Force a lookup miss: gmail in mode=delegated for `imminent_2h` —
    // the catalog only maps `imminent_2h` to calendar integrations, so
    // no row should appear even if gmail is delegated.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        gmail: state({ mode: "delegated", delegatedBackend: "claude" }),
        google_calendar: state({ mode: "disabled" }),
        notion: state({ mode: "disabled" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    // gmail's `unread_last_hour` window IS mapped → one row only.
    const fetches = plan.match(/<fetch /g) ?? [];
    expect(fetches.length).toBe(1);
    expect(plan).toContain('window="unread_last_hour"');
    expect(plan).not.toContain('window="imminent_2h"');
  });

  it("populates the routine + agent_day attributes on the block element", () => {
    const plan = buildAcquisitionPlan({
      ...baseInput,
      agentDay: "2026-05-11",
      routine: "routine.weekly_review",
      integrations: { google_calendar: state({ mode: "direct" }) },
      accounts: [],
    });
    expect(plan).toContain(
      '<acquisition-plan routine="weekly_review" agent_day="2026-05-11">',
    );
  });

  it("emits no rows for perAccount integrations in direct mode when the accounts list is empty", () => {
    // `direct` is the only mode that consults `accounts`: daemon-stored
    // OAuth tokens drive multi-account polling. Empty accounts ⇒ no
    // credentials ⇒ nothing to fetch.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      routine: "routine.morning_routine",
      integrations: { gmail: state({ mode: "direct" }) },
      accounts: [],
    });
    expect(plan).not.toContain("<fetch ");
  });

  it("emits ONE shared row for perAccount integrations in native mode (accountless MCP)", () => {
    // Native mode binds the integration to the session backend's own
    // MCP server, which authenticates as a single user. The daemon
    // does not store mailbox identifiers in this mode, so the pre-pass
    // must NOT fan out per (non-existent) account — that would collapse
    // the plan to empty and silently skip the pre-pass, leaving the
    // main session to do both fetch and synthesis in one run (the
    // routine.morning_routine $1-budget regression that this contract
    // fixes). Emit one row WITHOUT an `account` attribute so the
    // partial body's "default" fallback kicks in.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        gmail: state({ mode: "native", nativeBackend: "claude" }),
      },
      accounts: [],
    });
    const fetches = plan.match(/<fetch /g) ?? [];
    expect(fetches.length).toBe(1);
    expect(plan).toContain('integration="gmail"');
    expect(plan).toContain('mode="native"');
    expect(plan).toContain('window="inbox_today"');
    expect(plan).not.toContain("account=");
    expect(plan).not.toContain("label=");
  });

  it("emits ONE shared row for perAccount integrations in delegated-same mode (ignores stale accounts)", () => {
    // delegated-same routes through the session backend's bound MCP,
    // same single-tenant assumption as native. Even when the daemon
    // still has stale `mail_accounts` rows from a previous direct-mode
    // deployment, the dispatcher must not surface them — they would
    // generate observations under `gmail:<staleAccountId>` source
    // strings that the parent routine would then read as if a fresh
    // direct poll had produced them.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        gmail: state({ mode: "delegated", delegatedBackend: "claude" }),
      },
      accounts: [
        { integration: "gmail", accountId: "stale1", label: "stale1@x.test" },
        { integration: "gmail", accountId: "stale2", label: "stale2@x.test" },
      ],
    });
    const fetches = plan.match(/<fetch /g) ?? [];
    expect(fetches.length).toBe(1);
    expect(plan).toContain('mode="delegated-same"');
    expect(plan).not.toContain('account="stale1"');
    expect(plan).not.toContain('account="stale2"');
  });

  it("emits ONE shared row for perAccount integrations in delegated-cross mode", () => {
    // delegated-cross routes through the daemon proxy
    // `/api/integrations/<key>/exec`, which invokes the bound (other)
    // backend's MCP — also a single-tenant surface. Per-account
    // fan-out is not meaningful here either.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        gmail: state({ mode: "delegated", delegatedBackend: "codex" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    const fetches = plan.match(/<fetch /g) ?? [];
    expect(fetches.length).toBe(1);
    expect(plan).toContain('mode="delegated-cross"');
    expect(plan).not.toContain('account="acc1"');
  });

  it("native + perAccount + stale accounts: ignores stale account rows (mode-flip residue protection)", () => {
    // direct→native flip leaves `mail_accounts` rows in the DB until
    // the user (or a future cleanup task) removes them. Until then the
    // plan builder must NOT surface those stale rows on native plans —
    // otherwise the pre-pass would emit observations under
    // `gmail:<staleAccountId>` source strings that look like fresh
    // direct-poll output and would then participate in the parent
    // routine's source_prefix=gmail: filter alongside the legitimate
    // `gmail:default` rows the native MCP just produced.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        gmail: state({ mode: "native", nativeBackend: "claude" }),
      },
      accounts: [
        { integration: "gmail", accountId: "preflip-acc1", label: "old@x.test" },
        { integration: "gmail", accountId: "preflip-acc2", label: "old2@x.test" },
      ],
    });
    const fetches = plan.match(/<fetch /g) ?? [];
    expect(fetches.length).toBe(1);
    expect(plan).toContain('mode="native"');
    expect(plan).not.toContain("preflip-acc1");
    expect(plan).not.toContain("preflip-acc2");
    expect(plan).not.toContain("account=");
  });

  it("native + perAccount + accounts=[] for outlook_mail: ALSO emits one shared row", () => {
    // Outlook Mail covers the userManagedConnector path on top of the
    // generic non-direct shared-row rule. The combined behaviour
    // (single shared row, no `account` attribute, native query
    // variant) must hold for outlook_mail too — otherwise an
    // Outlook-only native deployment would silently skip the pre-pass
    // exactly the way the gmail-only case did.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        outlook_mail: state({ mode: "native", nativeBackend: "claude" }),
      },
      accounts: [],
    });
    const fetches = plan.match(/<fetch /g) ?? [];
    expect(fetches.length).toBe(1);
    expect(plan).toContain('integration="outlook_mail"');
    expect(plan).toContain('mode="native"');
    expect(plan).not.toContain("account=");
    // Mode-keyed query: native must use the Graph-filter form, not the
    // REST `since=` form.
    expect(plan).toContain("filter=receivedDateTime ge");
    expect(plan).not.toMatch(/query='\?since=/);
  });

  it("non-direct + perAccount: ALSO emits one row for userManagedConnector outlook_mail (delegated-cross collapses to same)", () => {
    // outlook_mail has `userManagedConnector: true`. resolveFetchMode
    // collapses delegated-cross → delegated-same for it (no daemon
    // proxy exists). Combined with the perAccount-direct-only contract,
    // a delegated-cross outlook_mail row should emit a single
    // delegated-same row WITHOUT an account attribute.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        outlook_mail: state({ mode: "delegated", delegatedBackend: "codex" }),
      },
      accounts: [
        { integration: "outlook_mail", accountId: "ms1", label: "ms@x.test" },
      ],
    });
    const fetches = plan.match(/<fetch /g) ?? [];
    expect(fetches.length).toBe(1);
    expect(plan).toContain('mode="delegated-same"');
    expect(plan).not.toContain('account="ms1"');
  });

  it("does not emit calendar rows for morning_routine in direct mode (ContextBuilder pre-fetches inline)", () => {
    // A8 / Finding 5 — `cal_morning_7d` intentionally omits the
    // `direct` cell from WINDOW_QUERIES. The ContextBuilder's
    // `<calendar_events_7d>` block still inlines events via the
    // daemon's CalendarService for direct mode, so a pre-pass row
    // would double-fetch. `lookupQuery` returns undefined → row
    // skipped silently.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      routine: "routine.morning_routine",
      integrations: {
        google_calendar: state({ mode: "direct" }),
        outlook_calendar: state({ mode: "direct" }),
      },
      accounts: [],
    });
    expect(plan).not.toContain('integration="google_calendar"');
    expect(plan).not.toContain('integration="outlook_calendar"');
  });

  it("emits a calendar row for morning_routine in native mode (A8 / Finding 5)", () => {
    // Native calendar without a pre-pass row was the second half of
    // the routine.morning_routine cost regression: the parent Sonnet
    // session received a ContextBuilder "fetch yourself" directive
    // and burned medium-tier turns driving the MCP fan-out. The
    // `cal_morning_7d` window's `native` cell is mapped, so the
    // dispatcher emits one row per active non-direct provider; the
    // Haiku pre-pass POSTs events into observations ahead of the
    // main session.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        google_calendar: state({ mode: "native", nativeBackend: "claude" }),
        gmail: state({ mode: "disabled" }),
        notion: state({ mode: "disabled" }),
      },
      accounts: [],
    });
    const fetches = plan.match(/<fetch /g) ?? [];
    expect(fetches.length).toBe(1);
    expect(plan).toContain('integration="google_calendar"');
    expect(plan).toContain('mode="native"');
    expect(plan).toContain('window="cal_morning_7d"');
    expect(plan).toContain('timeMin="');
    expect(plan).not.toContain("account=");
  });

  it("emits a calendar row for morning_routine in delegated-same mode", () => {
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        outlook_calendar: state({ mode: "delegated", delegatedBackend: "claude" }),
        gmail: state({ mode: "disabled" }),
        notion: state({ mode: "disabled" }),
      },
      accounts: [],
    });
    const fetches = plan.match(/<fetch /g) ?? [];
    expect(fetches.length).toBe(1);
    expect(plan).toContain('integration="outlook_calendar"');
    expect(plan).toContain('mode="delegated-same"');
    expect(plan).toContain('window="cal_morning_7d"');
  });

  it("morning_routine pre-pass is mixed-mode safe: native calendar emits, direct calendar is silently skipped", () => {
    // Google native (pre-pass owns) + Outlook direct (ContextBuilder
    // owns). The plan should emit Google but NOT Outlook — otherwise
    // direct Outlook would be double-fetched.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      sessionBackend: "claude",
      routine: "routine.morning_routine",
      integrations: {
        google_calendar: state({ mode: "native", nativeBackend: "claude" }),
        outlook_calendar: state({ mode: "direct" }),
        gmail: state({ mode: "disabled" }),
        notion: state({ mode: "disabled" }),
      },
      accounts: [],
    });
    expect(plan).toContain('integration="google_calendar"');
    expect(plan).toContain('mode="native"');
    expect(plan).not.toContain('integration="outlook_calendar"');
  });

  it("ignores accounts whose integration key has no descriptor in the window's WINDOW_QUERIES cell", () => {
    // An account with integration="git" would never match any mail
    // window. Defensive coverage — callers shouldn't pass these but
    // the helper must not crash.
    const plan = buildAcquisitionPlan({
      ...baseInput,
      routine: "routine.morning_routine",
      integrations: { gmail: state({ mode: "direct" }) },
      accounts: [
        { integration: "git" as IntegrationKey, accountId: "garbage" },
      ],
    });
    expect(plan).not.toContain('account="garbage"');
  });
});

describe("splitAcquisitionPlanByIntegration", () => {
  const ts = buildAcquisitionTimestamps(FIXED_NOW, "UTC", 0);
  const baseInput = {
    agentDay: "2026-05-11" as const,
    sessionBackend: "claude" as const,
    timestamps: ts,
  };

  it("returns one sub-plan per active integration (per-integration-key granularity)", () => {
    const subPlans = splitAcquisitionPlanByIntegration({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        gmail: state({ mode: "direct" }),
        google_calendar: state({ mode: "direct" }),
        notion: state({ mode: "direct" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    expect(subPlans).toHaveLength(3);
    const keys = subPlans.map((sp) => sp.integrationKey);
    expect(keys).toEqual(["gmail", "google_calendar", "notion"]);
  });

  it("collapses to one sub-plan when only one integration is active", () => {
    const subPlans = splitAcquisitionPlanByIntegration({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        google_calendar: state({ mode: "direct" }),
      },
      accounts: [],
    });
    expect(subPlans).toHaveLength(1);
    expect(subPlans[0]!.integrationKey).toBe("google_calendar");
  });

  it("returns an empty array when no integration contributes a row", () => {
    const subPlans = splitAcquisitionPlanByIntegration({
      ...baseInput,
      routine: "routine.monthly_review",
      integrations: {},
      accounts: [],
    });
    expect(subPlans).toEqual([]);
  });

  it("returns an empty array when every integration is disabled", () => {
    const subPlans = splitAcquisitionPlanByIntegration({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        gmail: state({ mode: "disabled" }),
        google_calendar: state({ mode: "disabled" }),
        notion: state({ mode: "disabled" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    expect(subPlans).toEqual([]);
  });

  it("groups multi-account fan-out rows under one gmail sub-plan with rowsHaveAccount=true", () => {
    const subPlans = splitAcquisitionPlanByIntegration({
      ...baseInput,
      routine: "routine.morning_routine",
      integrations: {
        gmail: state({ mode: "direct" }),
      },
      accounts: [
        { integration: "gmail", accountId: "acc1", label: "a@x.test" },
        { integration: "gmail", accountId: "acc2", label: "b@x.test" },
      ],
    });
    expect(subPlans).toHaveLength(1);
    const gmail = subPlans[0]!;
    expect(gmail.integrationKey).toBe("gmail");
    expect(gmail.fetchRowCount).toBe(2);
    expect(gmail.rowsHaveAccount).toBe(true);
    const fetches = gmail.block.match(/<fetch /g) ?? [];
    expect(fetches.length).toBe(2);
    expect(gmail.block).toContain('account="acc1"');
    expect(gmail.block).toContain('account="acc2"');
  });

  it("emits rowsHaveAccount=false for accountless integrations", () => {
    const subPlans = splitAcquisitionPlanByIntegration({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        google_calendar: state({ mode: "direct" }),
        notion: state({ mode: "direct" }),
      },
      accounts: [],
    });
    expect(subPlans.map((sp) => sp.integrationKey)).toEqual([
      "google_calendar",
      "notion",
    ]);
    for (const sp of subPlans) expect(sp.rowsHaveAccount).toBe(false);
  });

  it("wraps each sub-plan with a scoped=<key> attribute on its acquisition-plan element", () => {
    const subPlans = splitAcquisitionPlanByIntegration({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        gmail: state({ mode: "direct" }),
        google_calendar: state({ mode: "direct" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    expect(subPlans).toHaveLength(2);
    expect(subPlans[0]!.block).toContain('scoped="gmail"');
    expect(subPlans[1]!.block).toContain('scoped="google_calendar"');
    // Every sub-plan still carries the routine + agent_day attributes
    // unchanged — the partial assumes those are present.
    for (const sp of subPlans) {
      expect(sp.block).toContain('routine="hourly_check"');
      expect(sp.block).toContain('agent_day="2026-05-11"');
      expect(sp.block).toContain("</acquisition-plan>");
    }
  });

  it("sorts sub-plans by INTEGRATION_KEYS enumeration order regardless of input order", () => {
    // INTEGRATION_KEYS order: gmail → google_calendar → notion → git →
    // github → outlook_mail → outlook_calendar. Active set covers
    // gmail, notion, google_calendar — order in the output should
    // match the enumeration, not the JS object key order.
    const subPlans = splitAcquisitionPlanByIntegration({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        notion: state({ mode: "direct" }),
        gmail: state({ mode: "direct" }),
        google_calendar: state({ mode: "direct" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    expect(subPlans.map((sp) => sp.integrationKey)).toEqual([
      "gmail",
      "google_calendar",
      "notion",
    ]);
  });

  it("preserves the original plan's row count: sum(fetchRowCount) === buildAcquisitionPlan rows", () => {
    const input = {
      ...baseInput,
      routine: "routine.morning_routine" as const,
      integrations: {
        gmail: state({ mode: "direct" }),
        google_calendar: state({ mode: "direct" }),
        notion: state({ mode: "direct" }),
      },
      accounts: [
        { integration: "gmail" as IntegrationKey, accountId: "acc1" },
        { integration: "gmail" as IntegrationKey, accountId: "acc2" },
      ],
    };
    const fullPlan = buildAcquisitionPlan(input);
    const fullRowCount = (fullPlan.match(/<fetch /g) ?? []).length;
    const subPlans = splitAcquisitionPlanByIntegration(input);
    const splitRowCount = subPlans.reduce((sum, sp) => sum + sp.fetchRowCount, 0);
    expect(splitRowCount).toBe(fullRowCount);
    expect(splitRowCount).toBeGreaterThan(0);
  });

  it("skips integrations whose state is disabled — sub-plan absent rather than empty", () => {
    const subPlans = splitAcquisitionPlanByIntegration({
      ...baseInput,
      routine: "routine.hourly_check",
      integrations: {
        gmail: state({ mode: "disabled" }),
        google_calendar: state({ mode: "direct" }),
        notion: state({ mode: "disabled" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    expect(subPlans.map((sp) => sp.integrationKey)).toEqual([
      "google_calendar",
    ]);
  });

  it("every sub-plan's block is a self-contained, parseable acquisition-plan element", () => {
    const subPlans = splitAcquisitionPlanByIntegration({
      ...baseInput,
      routine: "routine.morning_routine",
      integrations: {
        gmail: state({ mode: "direct" }),
        google_calendar: state({ mode: "direct" }),
      },
      accounts: [{ integration: "gmail", accountId: "acc1" }],
    });
    for (const sp of subPlans) {
      expect(sp.block.startsWith("<acquisition-plan ")).toBe(true);
      expect(sp.block.endsWith("</acquisition-plan>")).toBe(true);
      // Only ONE integration's rows live in each sub-plan block.
      const otherKeys = subPlans
        .map((s) => s.integrationKey)
        .filter((k) => k !== sp.integrationKey);
      for (const otherKey of otherKeys) {
        expect(sp.block).not.toContain(`integration="${otherKey}"`);
      }
    }
  });

  it("queries inside each sub-plan are token-substituted (identical to the monolithic plan)", () => {
    const input = {
      ...baseInput,
      routine: "routine.hourly_check" as const,
      integrations: {
        gmail: state({ mode: "direct" }),
      },
      accounts: [{ integration: "gmail" as IntegrationKey, accountId: "acc1" }],
    };
    const subPlans = splitAcquisitionPlanByIntegration(input);
    expect(subPlans).toHaveLength(1);
    expect(subPlans[0]!.block).toContain(`since=${ts.hour_start_iso}`);
    expect(subPlans[0]!.block).not.toMatch(/since=\{hour_start_iso\}/);
  });

  // Per-integration backend routing — the `requiredBackend` field tells
  // the runner which backend to spawn each sub-session on. These tests
  // cover every mode-to-backend mapping (direct / delegated-same /
  // delegated-cross / native + userManagedConnector overrides) so a
  // future change to `resolveIntegrationBackend` cannot silently break
  // the contract that `RoutineFetchWindowRunner.runOneIntegrationWithRetry`
  // depends on.
  describe("requiredBackend population", () => {
    it("direct mode → requiredBackend = input.sessionBackend (REST proxy works from any backend)", () => {
      const subPlans = splitAcquisitionPlanByIntegration({
        ...baseInput,
        sessionBackend: "claude",
        routine: "routine.hourly_check",
        integrations: { google_calendar: state({ mode: "direct" }) },
        accounts: [],
      });
      expect(subPlans).toHaveLength(1);
      expect(subPlans[0]!.requiredBackend).toBe("claude");
    });

    it("delegated-same mode → requiredBackend = delegatedBackend (== sessionBackend)", () => {
      const subPlans = splitAcquisitionPlanByIntegration({
        ...baseInput,
        sessionBackend: "claude",
        routine: "routine.hourly_check",
        integrations: {
          gmail: state({ mode: "delegated", delegatedBackend: "claude" }),
        },
        accounts: [{ integration: "gmail", accountId: "acc1" }],
      });
      expect(subPlans).toHaveLength(1);
      expect(subPlans[0]!.requiredBackend).toBe("claude");
    });

    it("delegated-cross mode (non-userManaged) → requiredBackend = sessionBackend (daemon proxy from any backend)", () => {
      const subPlans = splitAcquisitionPlanByIntegration({
        ...baseInput,
        sessionBackend: "claude",
        routine: "routine.hourly_check",
        integrations: {
          gmail: state({ mode: "delegated", delegatedBackend: "codex" }),
        },
        accounts: [{ integration: "gmail", accountId: "acc1" }],
      });
      expect(subPlans).toHaveLength(1);
      // delegated-cross uses the daemon proxy via curl — sub-session
      // can spawn on the default backend regardless of where the
      // delegation target lives.
      expect(subPlans[0]!.requiredBackend).toBe("claude");
    });

    it("delegated mode for userManagedConnector → requiredBackend = delegatedBackend (no daemon proxy)", () => {
      // outlook_mail / outlook_calendar have `userManagedConnector: true`.
      // There is no `/api/integrations/<key>/exec` proxy for them, so
      // the sub-session MUST spawn on `delegatedBackend` to reach the
      // user's own MCP — this is why `resolveFetchMode` collapses
      // delegated-cross to delegated-same for these descriptors.
      const subPlans = splitAcquisitionPlanByIntegration({
        ...baseInput,
        sessionBackend: "claude",
        routine: "routine.hourly_check",
        integrations: {
          outlook_mail: state({ mode: "delegated", delegatedBackend: "codex" }),
        },
        accounts: [],
      });
      expect(subPlans).toHaveLength(1);
      expect(subPlans[0]!.integrationKey).toBe("outlook_mail");
      expect(subPlans[0]!.requiredBackend).toBe("codex");
      // And the mode-attribute still collapses to delegated-same.
      expect(subPlans[0]!.block).toContain('mode="delegated-same"');
    });

    it("native mode → requiredBackend = nativeBackend even when it differs from sessionBackend", () => {
      // This is the structural fix: previously, a native binding whose
      // nativeBackend differed from sessionBackend was silently dropped
      // by resolveFetchMode. The fix routes the row to nativeBackend
      // via per-integration `requiredBackend`, and the runner spawns
      // the sub-session on that backend via BackendRouter's
      // `requestedBackendId`-only override.
      const subPlans = splitAcquisitionPlanByIntegration({
        ...baseInput,
        sessionBackend: "claude",
        routine: "routine.hourly_check",
        integrations: {
          gmail: state({ mode: "native", nativeBackend: "codex" }),
        },
        accounts: [],
      });
      expect(subPlans).toHaveLength(1);
      expect(subPlans[0]!.requiredBackend).toBe("codex");
      expect(subPlans[0]!.block).toContain('mode="native"');
    });

    it("native mode → requiredBackend = nativeBackend when it matches sessionBackend (same path, explicit)", () => {
      const subPlans = splitAcquisitionPlanByIntegration({
        ...baseInput,
        sessionBackend: "claude",
        routine: "routine.hourly_check",
        integrations: {
          gmail: state({ mode: "native", nativeBackend: "claude" }),
        },
        accounts: [],
      });
      expect(subPlans).toHaveLength(1);
      expect(subPlans[0]!.requiredBackend).toBe("claude");
    });

    it("mixed routine: each sub-plan carries its own requiredBackend", () => {
      // The hourly_check fans across mail / calendar / notion. Verify
      // that each integration gets the right backend independent of the
      // others: gmail-native-codex spawns on codex, google_calendar-direct
      // spawns on the default (claude), notion-delegated-same spawns on
      // claude. This is the canonical mixed-mode case from the
      // hourly_check design discussion.
      const subPlans = splitAcquisitionPlanByIntegration({
        ...baseInput,
        sessionBackend: "claude",
        routine: "routine.hourly_check",
        integrations: {
          gmail: state({ mode: "native", nativeBackend: "codex" }),
          google_calendar: state({ mode: "direct" }),
          notion: state({ mode: "delegated", delegatedBackend: "claude" }),
        },
        accounts: [],
      });
      expect(subPlans).toHaveLength(3);
      const byKey = Object.fromEntries(
        subPlans.map((sp) => [sp.integrationKey, sp.requiredBackend]),
      );
      expect(byKey).toEqual({
        gmail: "codex",
        google_calendar: "claude",
        notion: "claude",
      });
    });
  });
});

describe("buildAcquisitionPlanAssembly — drops (PREPASS_COST_REDUCTION_PLAN.md N3)", () => {
  const ts = buildAcquisitionTimestamps(FIXED_NOW, "UTC", 0);
  const baseInput = {
    routine: "routine.morning_routine" as const,
    agentDay: "2026-05-11",
    sessionBackend: "claude" as const,
    accounts: [],
    timestamps: ts,
  };

  it("returns the same subPlans as splitAcquisitionPlanByIntegration", () => {
    const input = {
      ...baseInput,
      integrations: {
        gmail: state({ mode: "native", nativeBackend: "claude" }),
        notion: state({ mode: "disabled" }),
      },
    };
    const assembly = buildAcquisitionPlanAssembly(input);
    expect(assembly.subPlans).toEqual(splitAcquisitionPlanByIntegration(input));
  });

  it("records no_state drops for integrations missing from the snapshot", () => {
    const assembly = buildAcquisitionPlanAssembly({
      ...baseInput,
      integrations: {},
    });
    expect(assembly.subPlans).toEqual([]);
    expect(assembly.drops.length).toBeGreaterThan(0);
    expect(assembly.drops.every((d) => d.reason === "no_state")).toBe(true);
  });

  it("records a disabled drop per (window × integration) cell", () => {
    const assembly = buildAcquisitionPlanAssembly({
      ...baseInput,
      integrations: { notion: state({ mode: "disabled" }) },
    });
    const notionDrops = assembly.drops.filter((d) => d.integration === "notion");
    expect(notionDrops.length).toBeGreaterThan(0);
    expect(notionDrops.every((d) => d.reason === "disabled")).toBe(true);
  });

  it("records no_binding for delegated mode without a backend binding", () => {
    const assembly = buildAcquisitionPlanAssembly({
      ...baseInput,
      integrations: { gmail: state({ mode: "delegated", delegatedBackend: null }) },
    });
    const gmailDrops = assembly.drops.filter((d) => d.integration === "gmail");
    expect(gmailDrops.length).toBeGreaterThan(0);
    expect(gmailDrops.every((d) => d.reason === "no_binding")).toBe(true);
  });

  it("records no_accounts for direct-mode per-account windows with zero accounts", () => {
    const assembly = buildAcquisitionPlanAssembly({
      ...baseInput,
      integrations: { gmail: state({ mode: "direct" }) },
      accounts: [],
    });
    const gmailDrops = assembly.drops.filter((d) => d.integration === "gmail");
    expect(gmailDrops.length).toBeGreaterThan(0);
    expect(gmailDrops.some((d) => d.reason === "no_accounts")).toBe(true);
    // No sub-plan was emitted for gmail — the drop is the only trace.
    expect(
      assembly.subPlans.find((p) => p.integrationKey === "gmail"),
    ).toBeUndefined();
  });

  it("records unknown_mode for an unrecognized mode string", () => {
    const assembly = buildAcquisitionPlanAssembly({
      ...baseInput,
      integrations: {
        gmail: state({ mode: "experimental" as unknown as IntegrationState["mode"] }),
      },
    });
    const gmailDrops = assembly.drops.filter((d) => d.integration === "gmail");
    expect(gmailDrops.length).toBeGreaterThan(0);
    expect(gmailDrops.every((d) => d.reason === "unknown_mode")).toBe(true);
  });

  it("records NO drops for an active integration that emits rows", () => {
    const assembly = buildAcquisitionPlanAssembly({
      ...baseInput,
      integrations: { gmail: state({ mode: "native", nativeBackend: "claude" }) },
    });
    expect(assembly.subPlans.some((p) => p.integrationKey === "gmail")).toBe(true);
    expect(assembly.drops.filter((d) => d.integration === "gmail")).toEqual([]);
  });

  it("records direct_inline_prefetch (NOT no_window_query) for the deliberately-omitted direct cal_morning_7d cell", () => {
    // WINDOW_QUERIES[cal_morning_7d] intentionally omits the `direct`
    // cells for both calendar providers — ContextBuilder pre-fetches
    // those events inline (`<calendar_events_7d>`), so a pre-pass row
    // would double-fetch. The drop must be classified as the documented
    // working-as-designed reason, not as a catalog hole.
    const assembly = buildAcquisitionPlanAssembly({
      ...baseInput,
      integrations: {
        google_calendar: state({ mode: "direct" }),
        outlook_calendar: state({ mode: "direct" }),
      },
    });
    const calDrops = assembly.drops.filter(
      (d) => d.window === "cal_morning_7d",
    );
    expect(calDrops).toEqual([
      {
        integration: "google_calendar",
        window: "cal_morning_7d",
        reason: "direct_inline_prefetch",
      },
      {
        integration: "outlook_calendar",
        window: "cal_morning_7d",
        reason: "direct_inline_prefetch",
      },
    ]);
    // The exact-match above also proves no `no_window_query` drop exists
    // for either (integration, cal_morning_7d) tuple. And no FetchRow /
    // sub-plan was emitted for the calendar integrations — the drop is
    // the only trace.
    expect(
      assembly.subPlans.find((p) => p.integrationKey === "google_calendar"),
    ).toBeUndefined();
    expect(
      assembly.subPlans.find((p) => p.integrationKey === "outlook_calendar"),
    ).toBeUndefined();
  });

  // Note: there is intentionally NO `no_window_query` reachability test.
  // Every (window, integration) pair reachable through ROUTINE_WINDOWS
  // carries `delegated` + `native` cells in WINDOW_QUERIES, and the only
  // missing `direct` cells (cal_morning_7d × both calendars) are the
  // documented intentional omission now classified as
  // `direct_inline_prefetch`. `no_window_query` therefore guards future
  // catalog holes only and is unreachable with today's catalog.
});
