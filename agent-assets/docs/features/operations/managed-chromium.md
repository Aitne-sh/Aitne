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
status: experimental
ask_examples:
  - What is B-4?
  - Can Aitne buy things for me?
  - What is the !~ token in my DM?
  - How do I enable managed Chromium purchases?
  - How do I block a site from managed Chromium?
locale: en-US
created: 2026-05-22
updated: 2026-07-01
keywords:
  - managed chromium
  - browser automation
  - purchase token
  - B-4
  - "!~xxxxxxxx"
  - per-site opt-in
  - experimental danger
  - hostname denylist
related:
  - features/integrations/browser-history
  - features/operations/approvals
  - concepts/safety-model
  - concepts/safety-and-execution
  - reference/disallowed-tools
ui_anchors:
  - /browser
  - /settings/integrations/browser-history-managed
  - /settings/integrations/browser-history-managed/b4
process_keys:
  - browser_task
  - message.dm
config_keys:
  - browserTaskHostnameDenylist
api_endpoints:
  - POST /api/browser-automation/b4/enabled
  - PATCH /api/browser-automation/sites/:siteKey/b4-config
  - GET /api/browser-automation/purchase-tokens
  - POST /api/browser-automation/sites/:siteKey/connect
  - POST /api/browser-task
---

# Managed Chromium (B-4)

B-4 is the experimental purchase-confirmation flow. When you ask the
agent to "buy X" or "complete the checkout", and the vendor is on your
B-4 allowlist (the short list of sites you have explicitly approved),
the daemon (Aitne's always-on background service) opens a managed
Chromium profile, fills the cart, and then stops. It waits for a
one-time token that you send back in a DM (direct message) before it
clicks the final confirm button. **It is default-off**, sits behind
every safety check the project ships, and stays hidden in the public
dashboard until the upstream B-3 surface (browser-history research)
has run smoothly for six weeks.

This page is written so it's safe to read whether you've turned it on
or not.

## What's Actually Gated

Before B-4 can run, every one of these must be true:

1. The **master toggle** `runtime_state.managed_chromium.b4_enabled`
   is `true`. Default is `false`, set via
   `POST /api/browser-automation/b4/enabled` with body
   `{ enabled: true, acknowledge: true }` (Approve-tier).
2. You've acknowledged the **experimental-danger modal** on
   `/settings/integrations/browser-history-managed/b4`. The modal
   lists the failure modes and warns that the guard is bypassable if
   the daemon or messaging platform is compromised.
3. At least one **primary DM channel** is set (Slack / Telegram /
   Discord / WhatsApp). The single-use token is delivered there; the
   dashboard never shows the raw token.
4. The **site is on your B-4 allowlist**. You enable each site one at
   a time via `PATCH /api/browser-automation/sites/:siteKey/b4-config`
   (Approve). A site that isn't on the allowlist can't run a B-4 flow,
   even when the master toggle is on.
5. The **site is signed in** through the B-2.5 per-site sign-in
   flow (`POST /api/browser-automation/sites/:siteKey/connect` →
   sign in by hand in the spawned UI Chromium →
   `POST .../finalize`). The daemon keeps the profile in a locked-down
   directory that no skill can reach (the absolute-block layer).

## Structural Defences (no hardcoded category denylist)

Earlier builds hardcoded a category denylist (banking, brokerages,
government, healthcare, identity / legal, payment processors). **That
framework-level category denylist was removed on 2026-05-27** — Aitne
is not a Japan-specific product and does not ship an opinionated brand
or category blocklist. What protects you now is structural, not a
category list:

1. **IP CIDR egress layer (hardcoded, not configurable).** Any
   navigation that resolves to a private (RFC1918), loopback,
   link-local, multicast, cloud-metadata (`169.254.169.254`), or the
   IPv6 equivalents is denied at the egress chokepoint
   (`shouldDenyEgress` in `egress-denylist.ts`). This is the extra
   layer of defence against SSRF (server-side request forgery, where a
   request is tricked into reaching an internal address) — it cannot be
   turned off.
2. **Payment-path blocker.** A URL-pattern matcher
   (`payment-path-blocker.ts`) trips at form-submit time on
   payment-handoff paths so the agent can't silently push a
   transaction through.
3. **The B-4 token primitive itself** — no final confirm without a
   live, matched, single-use token (see below).

**Domain-level deny is now user-managed.** If you want to keep B-4 (or
any browser task) away from specific hostnames, add them to
`browserTaskHostnameDenylist` (default empty, up to 500 entries) from
Dashboard → `/settings/integrations/browser-history-managed`. The list
ships empty.

## The Token Flow

1. The agent prepares the checkout in a managed Chromium tab and
   pauses at the final confirm step.
2. The daemon mints a single-use token with the prefix `!~` followed
   by 8 random base32 characters (alphabet `A-Z2-7`, e.g.
   `!~K7QM3ZAB`), inserts a
   `browser_automation_purchase_tokens` row keyed on a server-side
   `jti`, and DMs the token to a primary channel together with a
   screenshot of the exact cart state.
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
authenticated reads (B-2.5), and B-4. Per-site state is managed by
`managed-chromium-sites-store.ts`; the bootstrap UI flow is:

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
| Open-ended browser request (DM, dashboard, or scheduler) | `browser_task` (medium tier, Claude-only) — see `BROWSER_TASK_REDESIGN_PLAN.md` |

Proactive re-auth DMs come from the `reauth-detector` in
`managed-chromium-supervisor.ts`.

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
- There is no built-in category guard. Aitne will not refuse a
  high-stakes site for you (banks, brokerages, government, healthcare)
  — those decisions are yours. If you don't trust B-4 with a site,
  simply don't add it to the per-site allowlist, or add its hostname
  to `browserTaskHostnameDenylist`.

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
