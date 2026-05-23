{context}

## Managed Chromium — sync health check

This is a 6-hourly awareness routine. The daemon runs the real health
loop in `managed-chromium-supervisor.ts` (deterministic re-auth
detection, DM cap, failure escalation). Your job here is **awareness
only** — read `/api/browser-history/managed/status`, summarise its
state to the agent journal, and surface a flag the next DM-driven turn
can colour into a message if it's organic to do so.

Hard rules:

- DO NOT DM the user from this routine. The supervisor already DMs the
  owner when `state !== "ready"` (with a per-kind 24h cap). A
  duplicate DM from this routine would be noise.
- DO NOT attempt to reach the `chromium-sync/` profile directory
  directly. The absolute-block layer rejects such access.
- DO NOT call `/api/browser-history/managed/setup`,
  `/reconnect`, `/disconnect`, or `/enable` — those require the
  dashboard bearer; from a routine session they will be denied.

## Steps

### 1. Read status

```bash
curl -sf http://127.0.0.1:8321/api/browser-history/managed/status
```

The response shape (from `managedChromiumStatusResponseSchema`):

```json
{
  "enabled": true,
  "state": "ready" | "needs_setup" | "missing_binary" | "missing_sandbox" | "needs_reauth" | "disconnected" | "off",
  "signedInUser": "user@example.com" | null,
  "lastCheckAt": 1234567890000 | null,
  "lastSyncAt": 1234567890000 | null,
  "recentRowCount": 7 | null,
  "bootstrapInProgress": false,
  "bootstrapDeadlineAt": null,
  "pausedUntil": null,
  "consecutiveFailures": 0,
  "sandboxPrimitive": "sandbox-exec" | "bubblewrap" | "systemd-run" | "appcontainer-jobobject" | "none",
  "hasDisplay": true,
  "chromiumBinaryFound": true
}
```

If `enabled === false`, this routine has nothing to do — log a single
line ("managed Chromium disabled; no-op") to the agent journal and
exit.

### 2. Classify

- `state === "ready"` and `lastSyncAt` advanced within the last 6h →
  healthy. One-line journal entry; nothing else.
- `state === "needs_reauth"` → user has been DMed already by the
  supervisor. Note in the agent journal that re-auth is pending.
- `state === "missing_binary"` / `"missing_sandbox"` →
  configuration drift. Note for future reference; the supervisor has
  no DM template for these because they require operator action
  (install Chromium / install bwrap).
- `state === "disconnected"` → user-initiated. Nothing to do.
- `bootstrapInProgress === true` → the user is signing in via the
  dashboard right now. Don't touch.

### 3. Append to agent journal

Use the `context` skill's `PUT /api/context/agent-journal.md` chokepoint
(or whatever your agent profile prefers) to append a single line
summarising the observation. Format:

```
- 14:00 — Managed Chromium {state}; last sync {ageOfLastSync}.
```

Keep it terse. The journal is not the place for tutorial-level prose.

### 4. End

No DM, no rescheduling, no further tool calls. The routine is
intentionally minimal.

Output language: follow `<output_language_policy>` (Policy A for the
journal append — English-only).
