import type { Metadata } from "next";
import { APP_NAME, APP_TAGLINE, joinTaglineWithSentence } from "@aitne/shared";
import "./globals.css";
import { ThemeProvider } from "@/providers/theme-provider";
import { QueryProvider } from "@/providers/query-provider";
import { SSEProvider } from "@/providers/sse-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/shared/confirm-dialog";
import { LayoutShell } from "@/components/layout/layout-shell";

export const metadata: Metadata = {
  title: `${APP_NAME} Dashboard`,
  description: joinTaglineWithSentence(
    `${APP_NAME} — ${APP_TAGLINE}`,
    "Monitor and manage your personal AI agent.",
  ),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider>
          <QueryProvider>
            <SSEProvider>
              <TooltipProvider delayDuration={300}>
                <ConfirmProvider>
                  <LayoutShell>{children}</LayoutShell>
                </ConfirmProvider>
              </TooltipProvider>
            </SSEProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
