"use client";

import Link from "next/link";
import { Mail } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useHealth } from "@/lib/hooks/use-health";

/**
 * Phase 5 §4.9 — secondary surface for the Draft-Only Gmail workflow.
 * Appears only when Gmail is delegated on a backend whose sub-tier is
 * `draft-only` (Claude Code today). Static reminder + link in Phase 5;
 * a numeric counter (per Decision #6) needs an agent-side producer that
 * reports `list_drafts` counts, which is Phase 6 scope. Keeping the UX
 * at link-only here avoids shipping a dead counter endpoint.
 */
export function DraftsAwaitingCard() {
  const { data: health } = useHealth();

  const gmail = health?.integrationModes?.gmail;
  const show =
    gmail?.mode === "delegated" && gmail.subTier === "draft-only";
  if (!show) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Drafts awaiting send</CardTitle>
      </CardHeader>
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <Mail className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Gmail is delegated in Draft-Only mode — the agent creates drafts and
          DMs you the link; you finalize sends in Gmail. Open{" "}
          <Link
            href="https://mail.google.com/mail/u/0/#drafts"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            your drafts folder
          </Link>{" "}
          to review.
        </p>
      </div>
    </Card>
  );
}
