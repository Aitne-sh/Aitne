---
kind: reference
parent_skill: mail
---

Direct-mode write routes share `{ error: string, message: string, detail?: string }`. Map by the `error` code first, then `detail` for richer disambiguation.

| HTTP | `error` | `detail` | What it means / what to do |
|---|---|---|---|
| 400 | `provider_not_enabled` | `kind_not_enabled` | The provider is authenticated but the user disabled that provider in settings. Tell the user and stop. |
| 400 | `provider_not_enabled` | `account_inactive` | This specific account is paused. Tell the user to re-enable it in the dashboard. Stop. |
| 400 | `provider_not_enabled` | `account_unhealthy` | **Credentials broken** (refresh rejected / app password expired). Tell the user to re-authenticate at `/connections/mail#<accountId>`. Stop. Do NOT treat as "provider disabled." |
| 404 | `not_found` | — | Account id unknown or message/thread id gone. First retry: re-resolve via `?active=1` (§1). If still 404, surface to user. |
| 410 | `integration_delegated` | — | Gmail flipped to delegated mode mid-session. This skill body is direct-only — re-read `integrations.md` and use `POST /api/integrations/gmail/exec` (cross-backend task mode) or your session backend's native Gmail MCP (the same-backend variant) instead. |
| 501 | `not_implemented` | — | Operation unavailable on this provider kind (e.g. IMAP draft writes, Outlook attachment download). Fall back to the provider's native UI and tell the user. |
| 502 | `provider_auth_error` | — | Upstream rejected the credentials mid-call. Re-consent needed. Do NOT retry; tell the user. |
| other 5xx | — | — | Transient. Backoff, one retry, then surface the error text. |
