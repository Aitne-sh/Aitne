"use client";

import { useEffect, useMemo, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { DEFAULT_AGENT_DISPLAY_NAME } from "@aitne/shared";
import { BasicsStep } from "@/components/setup/basics-step";
import { VaultStep } from "@/components/setup/vault-step";
import { BackendsStep } from "@/components/setup/backends-step";
import { MailStep } from "@/components/setup/mail-step";
import { CalendarStep } from "@/components/setup/calendar-step";
import { NoteStep } from "@/components/setup/note-step";
import { MessagingStep } from "@/components/setup/messaging-step";
import { ConversationStep } from "@/components/setup/conversation-step";
import { SetupComplete } from "@/components/setup/setup-complete";
import {
  BASE_INITIAL_STEPS,
  STEP_LABELS,
  deriveVaultMode,
  filterInitialSteps,
  type SetupStep,
} from "@/components/setup/wizard-steps.logic";
import { useConfig } from "@/lib/hooks/use-config";
import { cn } from "@/lib/utils";
import { readWizardState, writeWizardState, clearWizardState } from "@/lib/setup-storage";

function SetupPageInner() {
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode") === "update" ? "update" : "initial";
  const { data: config } = useConfig();

  // Wizard state is persisted in sessionStorage so a page reload mid-setup
  // restores progress. Update mode short-circuits to the rules step (the
  // chat-driven Customize Rules screen).
  const [step, setStep] = useState<SetupStep>(() =>
    mode === "update"
      ? "rules"
      : ((readWizardState().step as SetupStep | undefined) ?? "basics"),
  );
  const [agentDisplayName, setAgentDisplayName] = useState(() =>
    mode === "update"
      ? DEFAULT_AGENT_DISPLAY_NAME
      : (readWizardState().agentDisplayName ?? ""),
  );

  const [modeOverride, setModeOverride] = useState<
    "plain" | "obsidian" | null
  >(() => (mode === "initial" ? readWizardState().modeOverride ?? null : null));
  const pendingVaultMode = deriveVaultMode(modeOverride, config?.vaultMode);
  const onPendingVaultModeChange = (next: "plain" | "obsidian") => {
    setModeOverride(next);
  };

  // The chosen primary-vault path is held here (not committed) until the
  // user enters the Customize Rules step.
  // Hydrated from sessionStorage only; we don't seed from
  // `config.primaryVaultPath` because (a) initial-mode runs start from a
  // plain default so there's nothing useful to seed, and (b) the
  // DirectoryPickerField in VaultStep already passes
  // `config.primaryVaultPath` as the picker's `defaultPath`, so a user
  // re-doing setup over a prior install sees the previous folder in the
  // native picker without us setting state inside an effect.
  const [pendingVaultPath, setPendingVaultPath] = useState<string>(
    () =>
      mode === "initial"
        ? (readWizardState().pendingVaultPath ?? "")
        : "",
  );

  // Persist wizard state on every change so reload restores progress.
  useEffect(() => {
    if (mode === "update") return;
    writeWizardState({
      step,
      agentDisplayName,
      modeOverride,
      pendingVaultPath: pendingVaultPath || null,
    });
  }, [mode, step, agentDisplayName, modeOverride, pendingVaultPath]);

  // Reaching `complete` means rules were saved successfully — clear all
  // persisted setup state so any future setup re-entry starts clean.
  useEffect(() => {
    if (step === "complete") {
      clearWizardState();
    }
  }, [step]);

  // Reset scroll position whenever the step changes — without this, a tall
  // previous step (e.g. Backends) leaves scrollTop mid-page and the next
  // step (e.g. Mail) renders mid-page instead of from the top.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [step]);

  // `filterInitialSteps` is currently identity (no conditional
  // sub-steps); kept as a function so future conditional gating has an
  // obvious home.
  const INITIAL_STEPS = useMemo<SetupStep[]>(
    () => filterInitialSteps(),
    [],
  );

  const next = () => {
    const idx = INITIAL_STEPS.indexOf(step);
    if (idx < INITIAL_STEPS.length - 1) {
      setStep(INITIAL_STEPS[idx + 1]);
    }
  };

  const currentIdx = INITIAL_STEPS.indexOf(step);

  // Update mode opens directly on `rules` with no prior step to return
  // to. On initial runs every step except basics/complete gets a Back
  // button.
  const canGoBack =
    mode === "initial" && currentIdx > 0 && step !== "complete";
  const prev = canGoBack
    ? () => setStep(INITIAL_STEPS[currentIdx - 1])
    : undefined;

  return (
    <div className="flex h-full flex-col">
      {mode === "initial" &&
        step !== "complete" && (
          <div className="flex items-center justify-center gap-1 border-b border-border bg-muted/30 px-4 py-3">
            {INITIAL_STEPS.filter((s) => s !== "complete").map((s, i) => {
              const stepIdx = INITIAL_STEPS.indexOf(s);
              const isActive = s === step;
              const isDone = stepIdx < currentIdx;

              return (
                <div key={s} className="flex items-center gap-1">
                  {i > 0 && (
                    <div
                      className={cn(
                        "h-px w-6",
                        isDone ? "bg-primary" : "bg-border",
                      )}
                    />
                  )}
                  <div
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : isDone
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-5 w-5 items-center justify-center rounded-full text-[10px]",
                        isActive
                          ? "bg-primary-foreground/20"
                          : isDone
                            ? "bg-primary/20"
                            : "bg-muted",
                      )}
                    >
                      {isDone ? "✓" : i + 1}
                    </span>
                    {STEP_LABELS[s]}
                  </div>
                </div>
              );
            })}
          </div>
        )}

      {/* Step content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {step === "basics" && (
          <BasicsStep
            agentDisplayName={agentDisplayName}
            onAgentDisplayNameChange={setAgentDisplayName}
            onNext={next}
          />
        )}
        {step === "vault" && (
          <VaultStep
            onNext={next}
            onBack={prev}
            pendingVaultMode={pendingVaultMode}
            onPendingVaultModeChange={onPendingVaultModeChange}
            pendingVaultPath={pendingVaultPath}
            onPendingVaultPathChange={setPendingVaultPath}
          />
        )}
        {step === "backend" && <BackendsStep onNext={next} onBack={prev} />}
        {step === "mail" && <MailStep onNext={next} onBack={prev} />}
        {step === "calendar" && <CalendarStep onNext={next} onBack={prev} />}
        {step === "note" && <NoteStep onNext={next} onBack={prev} />}
        {step === "messaging" && <MessagingStep onNext={next} onBack={prev} />}
        {step === "rules" && (
          <ConversationStep
            mode={mode}
            agentDisplayName={agentDisplayName}
            onComplete={() => setStep("complete")}
            onBack={prev}
            pendingVaultMode={pendingVaultMode}
            pendingVaultPath={pendingVaultPath}
          />
        )}
        {step === "complete" && (
          <SetupComplete
            mode={mode}
            agentDisplayName={agentDisplayName || DEFAULT_AGENT_DISPLAY_NAME}
          />
        )}
      </div>
    </div>
  );
}

export default function SetupPage() {
  return (
    <Suspense>
      <SetupPageInner />
    </Suspense>
  );
}
