---
doc_type: runbook
doc_status: active
project: personal-agent
area: operations
owner: aitne
created: 2026-04-17
updated: 2026-05-18
tags:
  - "project/personal-agent"
  - "doc/runbook"
  - "area/operations"
  - "state/active"
aliases:
  - "setup"
  - "installation guide"
related:
  - "./index.md"
  - "./advisor.md"
  - "./troubleshooting.md"
---
# Aitne — Setup Guide

This is the end-to-end install walkthrough. The short version is at the top of [README.md](../README.md); this doc covers every prerequisite, every backend, every integration mode, and every recovery step.

## Prerequisites

- **Node.js** ≥ 22 (LTS)
- **pnpm** 10.x — only required if you install from source (`packageManager: pnpm@10.12.1`)
- One AI backend installed and authenticated (see [AI backend authentication](#ai-backend-authentication))
- One messaging adapter configured (Slack / Telegram / Discord / WhatsApp / Web dashboard)

## Quick start (npm)

```bash
npm install -g @aitne-sh/aitne@latest
aitne start
```

`aitne start` builds if stale, launches the daemon on `:8321` and the dashboard on `:3000`, and opens a browser to the 9-step setup wizard. Verify with:

```bash
aitne status   # PIDs, uptime, connected platforms, today's spend
aitne doctor   # 10-check install diagnostic
aitne logs -f  # tail the daemon log
```

## Quick start (from source)

```bash
git clone https://github.com/Aitne-sh/Aitne.git aitne
cd aitne
corepack enable
pnpm install
pnpm dev          # foreground mode with full stdio
# or
pnpm start        # background mode (same flow as `aitne start`)
```

## Configuration model

`.env` is **bootstrap-only**. Only these four keys belong there:

| Key | Default | Description |
|---|---|---|
| `PA_DATA_DIR` | `~/.personal-agent` | Where runtime state lives (DB, logs, context Markdown, secrets) |
| `PA_API_PORT` | `8321` | Daemon HTTP port (loopback only) |
| `PA_LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent` |
| `PA_ENFORCE_READ_TOKEN` | `true` | Set to `false` for soft enforcement of the `X-Read-Token` header (log warning but allow) |

Everything else — ~100 runtime keys covering schedule, notifications, model bindings, character, mail providers, voice transcription, delegated mode — is editable from the dashboard at `:3000`, or via natural-language DMs to the agent. Bot tokens and OAuth credentials always live in the OS keychain via `PlatformSecretStore`, never in environment variables.

If you previously had secrets in `.env`, the daemon migrates them into the keychain on first launch and `chmod 0600`s the file.

## AI backend authentication

Aitne can drive Claude Code, Codex CLI, or Gemini CLI. The recommended operating mode is **provider API keys** entered into the setup wizard's **Backends** step; the daemon stores them in the keychain and mirrors them into `process.env` for the SDK / CLI subprocess.

| Backend | Install | Keychain key | Env var the daemon mirrors |
|---------|---------|--------------|----------------------------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `anthropic_api_key` | `ANTHROPIC_API_KEY` |
| Codex CLI | `npm install -g @openai/codex` | `openai_api_key` | `OPENAI_API_KEY` |
| Gemini CLI | `npm install -g @google/gemini-cli` | `gemini_api_key` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| OpenCode | _coming soon_ — registered for preview; runtime executor lands in a later release | — | — |

Resolution precedence (highest first):

1. **Keychain** — set via the dashboard.
2. **Original shell env** — captured at daemon startup.
3. **CLI login / OAuth fallback** — the SDK / CLI's own subscription-auth path (`claude` / `codex login` / `gemini auth`).

The dashboard surfaces a warning when a backend resolves to (3). Most providers — Anthropic in particular — do not officially support running automated agents on a personal subscription. Register an API key to stay clear of that gray area.

### Per-process model bindings

Aitne seeds per-process default models from a fixed map at install time — there is **no subscription-plan registration**. The seed lives in `packages/daemon/src/core/backends/plan-presets.ts` (`DELEGATED_PROCESS_KEYS` + `applyDefaultPresets`):

- **Owner-facing work** (DMs, dashboard chat, morning / daily / weekly / monthly routines, knowledge import) → `DEFAULT_CLAUDE_MEDIUM_MODEL` (Sonnet).
- **Delegated / simple surfaces** (mail polling, GitHub event triage, git observers, calendar-change handlers, `delegated_task` invoker, integration drift sync) → `DEFAULT_CLAUDE_LITE_MODEL` (Haiku).
- **High** (Opus / GPT-5.5 / Gemini 3 Pro) is registered but never auto-selected; opt in per row from `/settings/models`.

`PUT /api/backends/main` switches the main backend and re-seeds the default rows. `POST /api/backends/apply-defaults` re-seeds without changing the main backend. Per-process pins made via `PUT /api/process-config/:processKey` or the dashboard's Models page tag the row as `updated_by='user'` and survive re-seeds unless `force=true` is passed.

See [Advisor](./advisor.md) for the optional server-side reviewer.

## Directory layout

The daemon creates `~/.personal-agent/` on first run (override with `PA_DATA_DIR`):

```
~/.personal-agent/
├── context/                  # Plain-Markdown memory (the only chokepoint is the API)
│   ├── today.md              # Working view, always injected
│   ├── yesterday.md          # Daemon-rotated archive
│   ├── roadmap.md            # Long-term goals
│   ├── _index.md
│   ├── context-index.md
│   ├── user/                 # profile.md, people.md, work.md, expertise.md, personal.md, goals.md
│   ├── rules/                # management.md, mcp.md, redaction.md, policies/
│   ├── routines/             # hourly.md, morning.md, evening.md, weekly.md, custom/
│   ├── projects/             # One file per active project
│   ├── git/                  # Tracked clones
│   ├── git-repos/            # Per-repo metadata
│   ├── daily/YYYY-MM-DD.md   # Synthesized daily journal
│   ├── weekly/               # Weekly retrospectives
│   ├── monthly/              # Monthly reviews
│   ├── dossiers/             # Long-running entity files
│   ├── inbox/                # Captured-but-unprocessed
│   └── agent/                # Private agent self-reflection (journal.md, scratch/)
├── data/                     # SQLite DB (personal_agent.db + WAL/SHM)
├── secrets/                  # Encrypted blob store (Linux/Windows fallback only)
├── logs/                     # Daemon + dashboard logs
└── tmp/                      # Scratch space
```

Context writes flow through `curl http://localhost:8321/api/context/<path>` — never `Edit` / `Write` directly. The daemon enforces write locks, frontmatter validation, and 30-day snapshots at that chokepoint. SQLite (`better-sqlite3` with FTS5) backs sessions, observations, agent actions, and history.

## Daemon HTTP API

The daemon listens on `http://127.0.0.1:8321` (configurable via `PA_API_PORT`). The dashboard's server-side proxy injects the bearer token automatically; direct callers must include `Authorization: Bearer <apiToken>` for tier-`Approve` routes. The token is generated on first boot and stored in the keychain as `apiToken`.

| Group | Examples | Auth |
|---|---|---|
| Health | `GET /api/health`, `GET /api/metrics` | Public (localhost) |
| Context | `GET/PUT/PATCH /api/context/:path`, `POST /api/context/archive-today` | Autonomous |
| Agent | `POST /api/agent/notify`, `POST /api/agent/run-now`, `POST /api/agent/schedule` | Approve |
| Observations | `GET /api/observations/pending`, `POST /api/observations` | Autonomous |
| Backends | `GET/PUT /api/backends/main`, `PUT /api/backends/advisor`, `POST /api/backends/apply-defaults` | Approve |
| Integrations | `GET/PATCH /api/integrations`, `POST /api/integrations/:key/probe` | Approve |
| Mail | `GET /api/mail/messages`, `POST /api/mail/drafts`, … | Approve |
| Calendar | `GET /api/calendar/events`, `GET /api/calendar/availability` | Approve |
| Notion / Git / GitHub | `GET /api/notion/databases/:id`, `GET /api/git/log/:repo`, `POST /webhook/github` | Approve / public webhook |
| Dashboard | `GET /api/config`, `GET /api/events`, `GET /api/conversations`, `GET /api/cost`, `GET /api/approvals` | Approve |
| Streams | `GET /api/chat/stream`, `GET /api/events/stream` | Bearer-gated SSE |

`POST /api/escalate` is a 410 Gone stub — automatic Opus escalation was removed. Explicit-Opus paths are the dashboard chat model picker, `agent_schedule.model='opus'`, and `POST /api/agent/run-now { requestedModel: 'opus' }`. See [Advisor](./advisor.md) for the in-session second-reviewer alternative.

## Context write permissions

The Claude / Codex / Gemini session running in any given turn has the SDK `Edit` / `Write` tools removed from its tool list. Memory updates go through `PUT` / `PATCH /api/context/:path` instead, and the daemon enforces a write matrix per file. The current contract:

| File | PUT (replace) | PATCH (section) |
|------|:---:|:---:|
| `today.md` | ✓ | ✓ |
| `user/*.md` | — | ✓ (`Learned Context` section only on `profile.md`) |
| `roadmap.md` | — | ✓ |
| `projects/*.md` | ✓ | ✓ |
| `daily/*.md` | ✓ | — |
| `weekly/*.md` | ✓ | — |
| `rules/management.md` | — | — |

PATCH modes: `append`, `replace`, `clear`. The full matrix lives in `src/api/routes/context/` — when in doubt, the source is authoritative.

## Integration access modes

Every external integration (Gmail, Outlook, Google Calendar, Notion, …) runs in one of four modes. Pick a mode in the setup wizard or per-card in `Settings → Integrations`; the dashboard runs a live capability probe before every flip and holds a per-key flip lock.

| Mode | Auth held by | Poller | Capabilities |
|---|---|---|---|
| `direct` | Daemon (OAuth in OS keychain) | Running | Full feature set — FTS5 mail search, classifiers, 15-min approach alerts, multi-account |
| `delegated` | Main backend's connector | Cron worker (per-cadence opt-in) | Whatever the connector exposes; subset of direct |
| `native` | Main backend's connector | None — reached in-turn via MCP | On-demand only |
| `disabled` | — | — | Off |

`native` is opened either by a descriptor that ships a `backendConnectors` entry (today: `gmail`, `google_calendar`, `notion`) or by a descriptor that declares `userManagedConnector: true` (today: `outlook_mail`, `outlook_calendar`). Changing the main backend cascades unmatched `native` rows to `disabled`.

`~/.personal-agent/integrations.md` is the human-readable source of truth for integration modes. The daemon reads the `Current state` table and watches the file for out-of-band edits; unknown keys log a warning, invalid mode values revert the file, and delegated flips whose required skill / task-flow variant files are missing are reverted with an owner DM listing the absolute paths.

### Direct mode — Gmail / Calendar (Google)

Direct gives you the full feature set at the cost of a 5–6 step Google Cloud console setup. Credentials are managed entirely through the dashboard; no environment variables are needed.

#### Step 1 — Create a Google Cloud project

1. Open [Google Cloud Console — Create Project](https://console.cloud.google.com/projectcreate).
2. Enter any project name (e.g. `aitne`) and click **Create**.

> If you already have a GCP project, select it from the top-left dropdown and skip to Step 2.

#### Step 2 — Enable the APIs

Open each link and click **Enable**. Verify the correct project is selected in the top-left dropdown for every API.

- [Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
- [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) (skip if you only need calendar)

#### Step 3 — Configure the OAuth consent screen

1. Open [OAuth Consent Screen](https://console.cloud.google.com/apis/credentials/consent).
2. Choose **External** and click **Create**.
3. Fill in: **App name** (any), **User support email** (your Gmail), **Developer contact email** (your Gmail).
4. Click **Save and Continue** through the Scopes section (no changes).
5. In **Test users**, click **Add Users** and enter the Gmail address you want to authorize.
6. Click **Save and Continue** → **Back to Dashboard**.

> The app stays in "Testing" mode — fine for personal use. Only the test users you added can authorize.

#### Step 4 — Create OAuth credentials

1. Open [Create OAuth Client ID](https://console.cloud.google.com/apis/credentials/oauthclient).
2. Set **Application type** to **Desktop app**.
3. Enter any name (e.g. `aitne-desktop`) and click **Create**.
4. Click **Download JSON** to save `client_secret_XXXX.json`.

> Desktop app needs no redirect URI configuration. If you choose Web instead, add `http://localhost:<PA_API_PORT>/api/config/google-auth/callback` (default port `8321`).

#### Step 5 — Upload and authorize in the dashboard

1. Open `http://localhost:3000/setup` (or the Google Calendar card on the overview).
2. Click **Upload credentials JSON** and select the downloaded file.
3. Click **Authorize with Google** — sign in with the Google account you added as a test user.
4. If a "Google hasn't verified this app" warning appears, click **Continue**.
5. Grant the requested permissions.

The daemon stores the OAuth token in the OS keychain and refreshes it automatically.

### Notion direct mode

Notion's `delegated` mode (the backend's built-in Notion connector) is the zero-friction default. The steps below apply only to Notion **direct** mode (FTS-shaped queries, structured property filters, write-attribution loop suppression, configurable poll cadence).

1. Open <https://www.notion.so/my-integrations> → **New integration** → name `aitne`, pick the workspace.
2. Defaults are fine; the daemon needs Read content + Update content + Insert content.
3. **Submit**, copy the **Internal Integration Token** (`ntn_...`).
4. In the dashboard → **Connections → Knowledge → Notion**, paste the token into **API Key** → **Save** (stored in keychain).
5. For each Notion database you want the agent to reach: open the database, top-right `···` → **Add connections** → pick your integration. Without this share step the API returns 404 even with a valid token.
6. Still on the Notion card, add label → UUID rows. The label is what the agent uses in instructions (`tasks`, `projects`); the UUID is the 32-character hex string in the database URL.

Add at least one mapping; without rows the NotionPoller stays idle.

### Switching modes later

Mode changes are hot — no daemon restart. Open the Integration card and pick a new mode.

- **`direct` → `delegated` / `native`** — dashboard runs the probe contract (backend binary, backend auth, every `requiredCapabilities` reported by the connector). Failures block the flip with an actionable deep link. A warning modal lists every feature that stops working. Existing OAuth tokens stay dormant in the keychain by default; "Purge credentials" is one click away.
- **`delegated` / `native` → `direct`** — if dormant tokens are still in the keychain, a single "Re-enable direct mode" button restores pollers without OAuth. Otherwise the dashboard launches the 5-step direct flow inline.
- **Backend switch while delegated / native** — the daemon re-probes every affected integration against the new backend. A failed probe keeps the row pinned to the old backend and DMs the owner with the error — the integration does not silently break.

## Outlook / Microsoft 365 mail

Outlook uses Microsoft Graph (OAuth 2.0 + PKCE). Register a free Azure AD app once, then connect as many Outlook / outlook.com / M365 accounts as you need.

### Step 1 — Register an Azure AD app (one-time)

1. Open [Azure portal — App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) and sign in.
2. Click **+ New registration**.
3. Fill in:
   - **Name**: anything, e.g. `Aitne`.
   - **Supported account types**: *Accounts in any organizational directory (Any Microsoft Entra ID tenant – Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)*.
   - **Redirect URI**: in the left-hand dropdown choose **`Public client/native (mobile & desktop)`** — **not** `Web`. Type `http://127.0.0.1/callback` in the box on the right.
4. Click **Register**.
5. On the *Overview* page, copy the **Application (client) ID**.

> **Trap #1** — picking `Web` in the redirect URI dropdown causes `Authorization failed: server_error`. Public client/native is required.

### Step 2 — Enable public client flows

1. Left sidebar → **Authentication**.
2. Scroll to *Advanced settings* → **Allow public client flows** → flip to **Yes** → **Save**.

> **Trap #2** — this toggle is off by default and also causes `server_error` if left off.

### Step 3 — Add API permissions

1. **API permissions** → **+ Add a permission** → **Microsoft Graph** → **Delegated permissions**.
2. Tick: `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`.
3. **Add permissions**.
4. (Work/school tenant only) If your org requires admin consent, click **Grant admin consent**. Personal accounts skip this.

### Step 4 — Connect in the dashboard

1. Dashboard → **Settings → Mail → Outlook card**.
2. Paste the **Application (client) ID** from Step 1. Leave Tenant as `common` unless your admin says otherwise.
3. **Save** → **Authenticate (browser)**. Complete sign-in. The daemon's loopback server captures the callback automatically.
4. After "Outlook account authenticated" appears, flip the **Enable** switch on the card.

> If the daemon runs headless (SSH / WSL), use **Authenticate (device code)** instead.

## Yahoo Mail

Yahoo uses app-password login over IMAP (no OAuth). Two-step verification must be enabled first at [Yahoo Account Security](https://login.yahoo.com/account/security).

1. Yahoo Account Security → **Generate and manage app passwords**.
2. App name → `Aitne` → **Generate password**.
3. Copy the 16-character password with spaces exactly (paste, don't retype).
4. Dashboard → **Settings → Mail → Yahoo Mail** → enter username + paste password.
5. **Authenticate** (daemon runs a live IMAP smoke test).
6. Flip the **Enable** switch.

## iCloud Mail

iCloud uses app-specific-password login over IMAP. Two-factor authentication must be enabled first at [Apple Account](https://account.apple.com).

1. Sign in to Apple Account → **Sign-In and Security → App-Specific Passwords**.
2. **+ Generate an app-specific password** → label `Aitne` → **Create**.
3. Copy the `xxxx-xxxx-xxxx-xxxx` password (dashes are required).
4. Dashboard → **Settings → Mail → iCloud Mail** → enter email + paste password.
5. **Authenticate** → flip **Enable**.

## Slack

1. Create a Slack app at <https://api.slack.com/apps>.
2. Enable **Socket Mode** and generate an App-Level Token (`xapp-...`).
3. Add Bot Token Scopes: `chat:write`, `files:read`, `im:history`, `im:write`, `app_mentions:read`.
4. Install to workspace and copy the Bot User OAuth Token (`xoxb-...`).
5. Dashboard → **Settings → Messaging → Slack** → paste both tokens → **Save**. The daemon stores them in the OS keychain.

## Discord

1. Create an application at <https://discord.com/developers/applications>.
2. Create a Bot and copy the token.
3. Enable **Message Content Intent** in the Bot settings.
4. Invite with scopes: `bot`, `applications.commands`; permissions: `Send Messages`, `Read Message History`.
5. Dashboard → **Settings → Messaging → Discord** → paste the token → **Save**.

## Telegram

1. Talk to [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → follow prompts → copy the bot token.
2. Dashboard → **Settings → Messaging → Telegram** → paste the token → **Save**.
3. DM the bot to receive the pairing magic phrase; reply with it to bind your owner chat ID.

## WhatsApp (owner-only)

WhatsApp is single-owner: exactly one configured phone number can DM the agent. Dependencies (`@whiskeysockets/baileys` + `qrcode-terminal`) ship with the daemon — nothing to install.

1. Dashboard → **Settings → Messaging → WhatsApp** → enter owner phone in E.164 format (`+818012345678`) → **Save**.
2. Restart the daemon in the foreground so the QR shows up on stdout: `aitne stop && aitne dev`.
3. Scan the QR with WhatsApp on your phone. The raw QR string is also written to `<PA_DATA_DIR>/whatsapp/auth/qr.txt` for up to 60 seconds.
4. Once the adapter logs `whatsapp connected`, stop the foreground process and start in the background: `aitne start`.
5. If the adapter later reports `logged out`, repeat steps 2–4.

## Auth health monitor

The daemon runs an hourly auth probe against every enabled backend and pages the owner before tokens silently expire. Tuning lives in runtime settings:

| Setting | Default | Description |
|---|---|---|
| `authProbeDisabled` | `false` | Kill switch (also `PA_AUTH_PROBE_DISABLED=true`) |
| `authPreflightFreshnessMs` | `600000` (10 min) | Milliseconds within which a cached `expired`/`missing` status causes the dispatcher to skip the main backend and fall through to the fallback. Set to `0` to disable pre-flight auth checks |
| `PA_AUTH_KEEPALIVE_DAYS` (env) | `60` | Idle days before a keepalive reminder DM is sent |
| `PA_GEMINI_OAUTH_GRACE_HOURS` (env) | `24` | Hours to tolerate a missing `refresh_token` in Gemini's `oauth_creds.json` (`0` disables the grace window) |
| `PA_GEMINI_OAUTH_CLIENT_ID` / `_SECRET` (env) | unset | Override Gemini OAuth client credentials for recovery (both required — otherwise the daemon extracts credentials from the CLI bundle) |

## Running as a system service

`aitne start` already daemonizes — for most users that's enough. To survive a reboot, wrap `aitne start` with a per-platform service manager.

### macOS — launchd

```bash
cat > ~/Library/LaunchAgents/sh.aitne.daemon.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>sh.aitne.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/aitne</string>
        <string>start</string>
        <string>--no-open</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/aitne.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/aitne.stderr.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/sh.aitne.daemon.plist
```

Replace `/usr/local/bin/aitne` with the output of `which aitne` if your `npm prefix` differs. `KeepAlive=false` is correct — `aitne start` exits 0 after spawning the background daemon, so launchd should not restart it.

If you use WhatsApp, do the initial QR pairing in a foreground terminal (`aitne dev`) before loading the launchd plist; the QR code is not practical to scan from `/tmp/aitne.stdout.log`.

### Linux — systemd user unit

```ini
# ~/.config/systemd/user/aitne.service
[Unit]
Description=Aitne local-first personal agent
After=network.target

[Service]
Type=forking
ExecStart=%h/.local/share/npm/bin/aitne start --no-open
ExecStop=%h/.local/share/npm/bin/aitne stop
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now aitne
```

## Related documents

- [Documentation index](./index.md)
- [Troubleshooting guide](./troubleshooting.md)
- [Maintenance playbook](./maintenance.md)
- [Advisor](./advisor.md)
