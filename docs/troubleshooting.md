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
  - "troubleshooting guide"
  - "ops diagnostics"
related:
  - "./index.md"
  - "./setup-guide.md"
  - "./advisor.md"
---
# Aitne — Troubleshooting

First stop is always `aitne doctor` — it runs ten install-health checks plus repo-drift expansion and prints a structured report. `aitne audit` reads the agent action log from SQLite (`--since`, `--type`, `--result`, `--backend`, `--detail`, `--json`).

## Quick diagnostics

```bash
# Daemon health
curl http://localhost:8321/api/health | jq .

# Load the API token from the OS keychain (macOS).
# The token is generated on first boot and stored as the `apiToken` keychain entry.
export PA_API_TOKEN="$(security find-generic-password -s 'aitne.apiToken' -w 2>/dev/null \
                       || aitne audit --json | jq -r '.[0].api_token // empty')"
# On Linux: `secret-tool lookup service aitne.apiToken`
# On Windows: read via the Credential Manager UI or `cmdkey`.

# Self-evaluation metrics
curl -H "Authorization: Bearer $PA_API_TOKEN" \
  http://localhost:8321/api/metrics | jq .

# Today's cost
curl -H "Authorization: Bearer $PA_API_TOKEN" \
  http://localhost:8321/api/cost | jq '.today'

# Recent actions
curl -H "Authorization: Bearer $PA_API_TOKEN" \
  'http://localhost:8321/api/events?limit=10' | jq '.events'
```

## Common issues

### Daemon won't start

**Symptom**: `aitne start` exits immediately, or `pnpm dev` errors out.

1. Check port conflict: `lsof -i :8321` (daemon) and `lsof -i :3000` (dashboard).
2. Check Node version: `node --version` (must be ≥ 22).
3. Check build: `pnpm build` (from-source installs) — fix any TypeScript errors.
4. Check logs: `aitne logs` or `cat ~/.personal-agent/logs/daemon.log`.

### No response to messages

**Symptom**: Owner sends a DM but gets no reply.

1. Platform connection:
   ```bash
   curl http://localhost:8321/api/health | jq '.connectedPlatforms'
   ```
2. Event bus not stuck:
   ```bash
   curl http://localhost:8321/api/health | jq '.eventBusSize'
   ```
   If > 100, the dispatcher may be blocked.
3. Concurrent-session ceiling:
   ```bash
   curl http://localhost:8321/api/health | jq '.activeSessions'
   ```
   If at `maxConcurrentSessions` (default 3), sessions are full.
4. Recent failures:
   ```bash
   curl -H "Authorization: Bearer $PA_API_TOKEN" \
     'http://localhost:8321/api/events?limit=5' | jq '.events[] | select(.result == "failed")'
   ```

### Outlook sign-in fails with `Authorization failed: server_error`

`server_error` from Microsoft almost always means an Azure app registration misconfiguration. Check both:

**Trap #1 — Wrong redirect URI platform**

1. Azure portal → App registrations → your app → **Authentication**.
2. Under *Platform configurations*, verify there's a **Mobile and desktop applications** section (not *Web*) containing `http://127.0.0.1/callback`.
3. If you see a *Web* section with that URI, delete it. **+ Add a platform** → **Mobile and desktop applications** → add `http://127.0.0.1/callback`.

**Trap #2 — Allow public client flows is off**

1. Same *Authentication* blade → scroll to **Advanced settings** at the bottom.
2. Flip **Allow public client flows** to **Yes** → **Save**.

Retry the connection from the dashboard. No need to change the client ID or re-register the app.

### High costs

**Symptom**: Daily cost exceeding budget.

1. Current cost: `curl -H "Authorization: Bearer $PA_API_TOKEN" http://localhost:8321/api/metrics | jq '.cost'`
2. Cost by model: `curl -H "Authorization: Bearer $PA_API_TOKEN" http://localhost:8321/api/cost | jq '.byModel'`
3. Sonnet vs Opus split: `curl -H "Authorization: Bearer $PA_API_TOKEN" http://localhost:8321/api/metrics | jq '.modelCounts'`
   - Opus sessions only land here when explicitly requested (dashboard chat model picker, `agent_schedule.model='opus'`, or `run-now requestedModel='opus'`). Automatic escalation was removed — see [Advisor](./advisor.md).
4. Set or lower `autonomousDailyCostCapUsd` via the dashboard's **Settings → Cost** card, or `PATCH /api/config { "autonomousDailyCostCapUsd": 1.0 }`. The cap triggers priority-based skipping: `hourly_check` at 100 %, `evening_review` at 150 %, `morning_routine` at 200 %. Reactive DMs are never gated.

### Notifications not arriving

1. Quiet hours active?
   ```bash
   curl -H "Authorization: Bearer $PA_API_TOKEN" \
     http://localhost:8321/api/config | jq '{quietHoursStart, quietHoursEnd}'
   ```
2. Rate limits:
   ```bash
   curl -H "Authorization: Bearer $PA_API_TOKEN" \
     http://localhost:8321/api/metrics | jq '.notificationCounts'
   ```
   If `suppressed` is high, `maxNotificationsPerHour` / `maxNotificationsPerDay` are kicking in. Defaults: 3 / hour, 12 / day.
3. Notification log:
   ```bash
   sqlite3 ~/.personal-agent/data/personal_agent.db \
     "SELECT status, COUNT(*) FROM notification_log WHERE date(created_at) = date('now') GROUP BY status"
   ```

### Morning routine not running

**Symptom**: `state/today.md` isn't generated in the morning.

1. Scheduler registered:
   ```bash
   curl http://localhost:8321/api/health | jq '.registeredObservers'
   ```
2. Scheduled tasks queue:
   ```bash
   sqlite3 ~/.personal-agent/data/personal_agent.db \
     "SELECT * FROM agent_schedule WHERE task_type LIKE '%routine%' ORDER BY scheduled_for DESC LIMIT 5"
   ```
3. Morning routine lock stuck:
   ```bash
   curl -X POST http://localhost:8321/api/context/lock/morning-routine
   # If returns 409, the lock is held — it auto-releases after 5 minutes.
   ```

### Database issues

**Symptom**: SQLite errors or corruption.

1. DB connectivity: `curl http://localhost:8321/api/health | jq '.dbConnected'`
2. WAL mode: `sqlite3 ~/.personal-agent/data/personal_agent.db "PRAGMA journal_mode"` (expect `wal`).
3. Integrity: `sqlite3 ~/.personal-agent/data/personal_agent.db "PRAGMA integrity_check"` (expect `ok`).
4. If corrupted, the documented recovery is clean reinstall (the schema policy is "no data migration"):
   ```bash
   aitne stop
   rm ~/.personal-agent/data/personal_agent.db*   # the * also clears -shm/-wal
   aitne start
   ```
   Context Markdown files are forward-compatible and survive the reinstall.

### Context files missing

**Symptom**: Agent can't find `identity/profile.md` or `state/today.md`.

1. List the tree: `ls -la ~/.personal-agent/context/`
2. Re-initialize — the daemon auto-creates the directory layout on startup; `aitne restart` is enough.
3. Health monitor alerts:
   ```bash
   curl http://localhost:8321/api/health | jq '.missingContextFiles'
   ```

## Database queries

Useful SQL for debugging:

```sql
-- Today's sessions by model
SELECT model_used, COUNT(*), SUM(cost_usd)
FROM agent_actions
WHERE date(started_at) = date('now')
GROUP BY model_used;

-- Failed sessions in the last 24h
SELECT action_type, error, started_at
FROM agent_actions
WHERE result = 'failed'
  AND started_at > datetime('now', '-1 day')
ORDER BY started_at DESC;

-- Notification delivery rate (last 7 days)
SELECT status, COUNT(*)
FROM notification_log
WHERE created_at > datetime('now', '-7 days')
GROUP BY status;

-- Active conversation sessions
SELECT platform, channel_id, model, message_count, last_message_at
FROM conversation_sessions
WHERE status = 'active';

-- Full-text search across messages
SELECT m.content, m.timestamp, s.platform
FROM fts_messages fts
JOIN messages m ON m.id = fts.rowid
JOIN conversation_sessions s ON s.id = m.session_id
WHERE fts_messages MATCH 'search term'
ORDER BY m.timestamp DESC
LIMIT 10;
```

## Logs

- **Daemon logs**: Structured JSON via pino, written to `~/.personal-agent/logs/daemon.log`. Follow with `aitne logs -f`.
- **Dashboard log**: `aitne logs -f -d`.
- **DB logs**: `agent_actions` table (use `aitne audit` or the `sqlite3` CLI).
- **Notification logs**: `notification_log` table.
- **Context-file snapshots**: `md_file_snapshots` table.

## Auth

| Route group | Auth |
|---|---|
| `/api/health`, agent helper routes (`/api/git/*`, `/api/mail/*`, `/api/obsidian/notes/*`) | Public (localhost only) |
| Dashboard / metrics / events / cost / approvals / write endpoints | `Authorization: Bearer $PA_API_TOKEN` |
| `X-Read-Token` header | Required for read-sensitive routes unless `PA_ENFORCE_READ_TOKEN=false` |

The bearer token is generated on first boot and stored in the OS keychain as `apiToken`. The Next.js dashboard injects it automatically via its server-side proxy.

## Performance targets

Check the self-evaluation metrics for performance issues:

```bash
curl -H "Authorization: Bearer $PA_API_TOKEN" \
  http://localhost:8321/api/metrics | jq '{
  responseTime,
  sonnetSelfSufficiencyRate,
  notificationConfirmRate
}'
```

Working targets for an active user:

- Response time: < 10 s (p90)
- Sonnet self-sufficiency: > 60 %
- Notification confirmation rate: > 70 %
- Daily cost: ≈ $0.50 typical; monthly cost: < $50

## Related documents

- [Documentation index](./index.md)
- [Setup guide](./setup-guide.md)
- [Advisor](./advisor.md)
- [Maintenance playbook](./maintenance.md)
