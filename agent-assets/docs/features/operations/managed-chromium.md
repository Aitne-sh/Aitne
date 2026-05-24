---
schema_version: 1
slug: features/operations/managed-chromium
title: Managed Chromium (B-4)
id: managed-chromium
aliases:
  - managed chromium
  - B-4
  - purchase confirmation
  - browser automation
  - chromium automation
category: features
summary: |
  Experimental, default-off purchase-confirmation flow. The daemon
  spawns a managed Chromium profile to complete a vendor checkout the
  agent has already prepared, after the operator approves with a
  single-use DM token. Heavily gated; designed to be safe to read about
  before you ever turn it on.
section: operations
tags:
  - operations
  - safety
  - browser-automation
  - experimental
status: experimental
ask_examples:
  - What is B-4?
  - Can Aitne buy things for me?
  - What is the !~ token in my DM?
  - How do I enable managed Chromium purchases?
  - What categories can't B-4 ever touch?
locale: en-US
created: 2026-05-22
updated: 2026-05-22
keywords:
  - managed chromium
  - browser automation
  - purchase token
  - B-4
  - "!~xxxxxxxx"
  - per-site opt-in
  - experimental danger
  - hard-deny
related:
  - features/integrations/browser-history
  - features/operations/approvals
  - concepts/safety-model
  - concepts/safety-and-execution
  - reference/disallowed-tools
ui_anchors:
  - /settings/browser-automation
  - /settings/browser-automation/sites
config_keys:
  - "runtime_state.managed_chromium.b4_enabled"
---

# Managed Chromium (B-4)

B-4 is the experimental purchase-confirmation flow. When you've asked
the agent to "buy X" or "complete the checkout", and the vendor is on
your B-4 allowlist, the daemon spawns a managed Chromium profile,
fills the cart, and pauses for an explicit one-time token from your
DM before clicking the final confirm. **It is default-off**, gated
behind every safety check the project ships, and not surfaced in the
public dashboard until the upstream B-3 surface (browser-history
research) has been stable for six weeks.

This page is written so it's safe to read whether you've enabled it
or not.

## What's Actually Gated

Before B-4 can run, every one of these must be true:

1. The **master toggle** `runtime_state.managed_chromium.b4_enabled`
   is `true`. Default is `false`, set via
   `POST /api/browser-automation/b4/enabled` with body
   `{ enabled: true, acknowledge: true }` (Approve-tier).
2. You've acknowledged the **experimental-danger modal** on
   `/settings/browser-automation`. The modal lists the failure modes,
   the §23 hard-deny categories, and that the guard is bypassable if
   the daemon or messaging platform is compromised.
3. At least one **primary DM channel** is set (Slack / Telegram /
   Discord / WhatsApp). The single-use token is delivered there; the
   dashboard never shows the raw token.
4. The **site is on your B-4 allowlist**. Per-site enablement happens
   via `PATCH /api/browser-automation/sites/:siteKey/b4-config`
   (Approve). Sites not in the allowlist cannot run a B-4 flow even
   if the master toggle is on.
5. The **site is signed in** through the B-2.5 per-site sign-in
   flow (`POST /api/browser-automation/sites/:siteKey/connect` →
   sign in by hand in the spawned UI Chromium →
   `POST .../finalize`). The daemon stores the profile in a
   restricted directory the absolute-block layer protects from any
   skill.

## The §23 Hard-Deny List

These categories are **absolutely denied** even with a valid token
and a fully approved site:

- Banking
- Brokerages
- Government services
- Healthcare
- Identity / legal
- Generic payment processors not bound to a registered commerce
  workflow

The check lives in the parent-plan policy and runs before the token
is even minted. There is no operator override.

## The Token Flow

1. The agent prepares the checkout in a managed Chromium tab and
   pauses at the final confirm step.
2. The daemon mints a single-use token with the prefix `!~` followed
   by 8 random hex characters (e.g. `!~3a1f9c7b`), inserts a
   `purchase_tokens` row keyed on a server-side `jti`, and DMs the
   token to a primary channel together with a screenshot of the
   exact cart state.
3. You reply with the token on the same DM channel. The daemon
   matches inbound text against pending tokens; a match advances the
   flow and the agent clicks confirm.
4. **5-minute timeout.** If no match arrives in 5 minutes, the token
   expires, the tab closes, and the agent reports back that the
   purchase was abandoned.
5. **Raw token never leaves the table.** The dashboard's audit views
   show `jti` + delivery state only — even a brief credential
   compromise can't extract live tokens.

`GET /api/browser-automation/purchase-tokens` lists pending +
recent (Approve-tier); `DELETE
/api/browser-automation/purchase-tokens/:jti` cancels a pending
token before its timeout.

## Site Bootstrap (B-2.5)

The same site infrastructure powers anonymous reads (B-2),
authenticated reads (B-2.5), and B-4. Per-site state lives in
`managed_chromium_sites_store`; the bootstrap UI flow is:

| Step | Route |
|---|---|
| Spawn a UI Chromium window to sign in by hand | `POST /api/browser-automation/sites/:siteKey/connect` |
| Poll progress | `GET /api/browser-automation/sites/:siteKey/status` |
| Confirm signed-in, close UI window | `POST /api/browser-automation/sites/:siteKey/finalize` |
| Re-spawn UI Chromium reusing the profile (re-auth) | `POST /api/browser-automation/sites/:siteKey/reauth` |
| Kill processes + delete the profile dir | `POST /api/browser-automation/sites/:siteKey/disconnect` |

## When It Runs

| Surface | Source |
|---|---|
| Operator asks the agent to "buy X" / "checkout" via DM | `message.dm` → checkout path |
| Scheduled / routine workflow request | `routine.browser_automation_request` (medium tier, Claude-only) |
| Health-check awareness | `routine.managed_sync_health_check` (lite, 6h, journal-only) |

The health check never DMs — proactive re-auth DMs come from the
`reauth-detector` in `managed-chromium-supervisor.ts`.

## Why You'd Turn It On

You wouldn't, yet. Until B-3 has been stable for six weeks, B-4 is
gated to project-owner self-testing. Once it opens, the typical
use case is recurring small purchases at vendors you trust (groceries,
specific subscriptions, narrow shopping windows) where the agent has
the cart context and you want a single tap to confirm rather than a
full hand-off.

## Why You Might Not

- The guard is **experimental and bypassable** if the daemon process
  or any of your messaging platforms is compromised. A high-privilege
  attacker on either side can pretend to be you and complete a
  purchase.
- Vendor flows change. A working B-4 site today can break tomorrow if
  the vendor restructures the checkout DOM — the agent's recovery
  story is "abandon and DM you", but you'll still see a partial cart.
- The categories listed in §23 above are intentionally off-limits.
  If your use case lives there, B-4 is not the right tool.

## Related

- [Approvals](approvals.md) — the broader Approve-tier model that
  governs everything B-4 routes through.
- [Safety Model](../../concepts/safety-model.md) — the categorical
  rules. B-4 narrows the "no financial transactions" rule to a
  gated, screenshot-first, token-bound exception.
- [Safety and Execution](../../concepts/safety-and-execution.md) — Safe
  / Allow modes and the absolute-block layer that protects the
  managed-Chromium profile dir from any skill.
- [Browser History](../integrations/browser-history.md) — separate
  read-only integration (B-3); B-4 builds on the same site
  registry but is a distinct surface.
- [Disallowed Tools](../../reference/disallowed-tools.md) — the
  absolute-block matchers that cover managed-Chromium profile
  directories.
