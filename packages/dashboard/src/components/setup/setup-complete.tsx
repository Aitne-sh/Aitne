"use client";

import { useRouter } from "next/navigation";
import { CheckCircle2, ArrowRight, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SetupCompleteProps {
  mode: "initial" | "update";
  agentDisplayName: string;
}

export function SetupComplete({ mode, agentDisplayName }: SetupCompleteProps) {
  const router = useRouter();

  return (
    <div className="flex flex-col items-center justify-center gap-8 py-16 text-center">
      <div className="rounded-full bg-emerald-100 p-6 dark:bg-emerald-950">
        <CheckCircle2 className="h-12 w-12 text-emerald-600 dark:text-emerald-400" />
      </div>

      <div className="max-w-md space-y-3">
        <h1 className="text-2xl font-bold text-foreground">
          {mode === "initial" ? "Setup Complete" : "Rules Updated"}
        </h1>
        <p className="text-muted-foreground">
          {mode === "initial"
            ? `${agentDisplayName} is ready. It will start watching the channels you connected and reach out as new context arrives.`
            : "Management Rules have been updated. Changes take effect immediately."}
        </p>
      </div>

      <div className="flex gap-3">
        <Button
          variant="outline"
          onClick={() => router.push("/memory")}
          className="gap-2"
        >
          <FileText className="h-4 w-4" />
          View Management Rules
        </Button>
        <Button
          onClick={() => router.push("/")}
          className="gap-2"
        >
          Go to Overview
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
