/**
 * Notifications Center — alert types surfaced on the Overview page.
 *
 * See docs/design/20-notifications-center.md for the schema rationale,
 * severity rules, and dismissal model.
 *
 * Each alert is detected by a pure function on the daemon side and
 * concatenated into `/api/health.alerts`. The dashboard renders them
 * severity-sorted in the NotificationsPanel.
 */

export type AlertSeverity = "error" | "warning" | "info";

export type AlertSource =
  | "system"
  | "auth"
  | "mail"
  | "config"
  | "cost"
  | "setup";

export interface Alert {
  /**
   * Stable identifier scoped to the alert's content.
   * Examples: `mail.reconsent.acct_42`, `cost.daily_cap`, `command.conflict.deploy`.
   * Used as the localStorage dismiss key on the client.
   */
  id: string;
  severity: AlertSeverity;
  /** One-line action statement (e.g. "Gmail account needs re-authentication"). */
  title: string;
  /** Optional context, ≤2 sentences. */
  description?: string;
  /** Relative deep link to the page that fixes this. */
  href?: string;
  source: AlertSource;
  /**
   * Whether the user can dismiss this. By design:
   * - error → false
   * - warning → true (snoozes 24h)
   * - info → true (dismisses permanently per fingerprint)
   */
  dismissable: boolean;
  /** ISO timestamp when this alert was first detected in this state. */
  detectedAt: string;
  /**
   * Content fingerprint. When the underlying state changes (e.g. a new
   * conflict appears) this changes too, so a previously-dismissed alert
   * resurfaces. Detectors compute it deterministically.
   */
  fingerprint: string;
}
