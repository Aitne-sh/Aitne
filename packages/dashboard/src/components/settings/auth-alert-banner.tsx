"use client";

import { Alert } from "@/components/ui/alert";
import { useAuthTelemetry } from "@/lib/hooks/use-auth-telemetry";
import { DocsLearnMore } from "@/components/docs/docs-learn-more";

/**
 * Red banner shown at the top of the Models page when infrastructure-level
 * auth telemetry counters (schema_parse_failed, keychain_read_failed,
 * credentials_file_read_failed) are non-zero in the last 24 hours.
 *
 * Phase 8 §7.4.
 */
export function AuthAlertBanner() {
  const { data } = useAuthTelemetry(24);
  if (!data) return null;

  const infraCounters: Array<{ key: string; label: string; total: number }> = [];

  for (const [backendId, counters] of Object.entries(data.counters)) {
    const schemaParseFailed = counters.schema_parse_failed ?? 0;
    const keychainReadFailed = counters.keychain_read_failed ?? 0;
    const credentialsFileReadFailed = counters.credentials_file_read_failed ?? 0;

    if (schemaParseFailed > 0) {
      infraCounters.push({
        key: `${backendId}:schema_parse_failed`,
        label: `${backendId} schema parse failures`,
        total: schemaParseFailed,
      });
    }
    if (keychainReadFailed > 0) {
      infraCounters.push({
        key: `${backendId}:keychain_read_failed`,
        label: `${backendId} keychain read failures`,
        total: keychainReadFailed,
      });
    }
    if (credentialsFileReadFailed > 0) {
      infraCounters.push({
        key: `${backendId}:credentials_file_read_failed`,
        label: `${backendId} credentials file read failures`,
        total: credentialsFileReadFailed,
      });
    }
  }

  if (infraCounters.length === 0) return null;

  return (
    <Alert variant="error">
      <div>
        <p className="font-medium">Credentials store errors detected (last 24h)</p>
        <ul className="mt-1 list-disc pl-4">
          {infraCounters.map((c) => (
            <li key={c.key}>
              {c.label}: {c.total}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-muted-foreground">
          Check daemon logs for details. This may indicate corrupted keychain entries or
          credential file permission issues.
        </p>
        <div className="mt-2">
          <DocsLearnMore
            docId="troubleshooting/auth-failed"
            label="How to recover →"
          />
        </div>
      </div>
    </Alert>
  );
}
