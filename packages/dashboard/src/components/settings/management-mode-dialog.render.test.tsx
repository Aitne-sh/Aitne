import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorPanel } from "./management-mode-dialog";

describe("ErrorPanel", () => {
  it("renders the recovery link and backup path when rollback help is needed", () => {
    const html = renderToStaticMarkup(
      <ErrorPanel
        status={500}
        body={{
          error: "move_failed",
          message: "File move failed.",
          backupPath: "/tmp/migration-backup",
          rollbackStatus: "manual_required",
        }}
        onDismiss={() => {}}
      />,
    );

    expect(html).toContain("Recovery instructions");
    expect(html).toContain("/tmp/migration-backup");
    expect(html).toContain("mm-recovery-instructions");
  });

  it("renders blocking sessions for 409 responses", () => {
    const html = renderToStaticMarkup(
      <ErrorPanel
        status={409}
        body={{
          error: "sessions_active",
          message: "Active sessions block migration. Wait for them to close.",
          sessions: [
            { id: 3, scope: "dashboard_chat", scope_key: "dashboard" },
          ],
        }}
        onDismiss={() => {}}
      />,
    );

    expect(html).toContain("Session #3");
    expect(html).toContain("dashboard_chat");
    expect(html).toContain("dashboard");
  });
});
