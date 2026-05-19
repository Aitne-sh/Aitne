/** Shared constants for Google OAuth setup UI */

export const GCP_LINKS = {
  createProject: "https://console.cloud.google.com/projectcreate",
  enableCalendarApi:
    "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
  enableGmailApi:
    "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  consentScreen:
    "https://console.cloud.google.com/apis/credentials/consent",
  createCredentials:
    "https://console.cloud.google.com/apis/credentials/oauthclient",
} as const;

/** How long to wait for the OAuth popup before timing out (ms). */
export const OAUTH_POPUP_TIMEOUT_MS = 120_000;
