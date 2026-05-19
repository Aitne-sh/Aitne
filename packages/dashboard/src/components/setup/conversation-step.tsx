"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  DEFAULT_AGENT_DISPLAY_NAME,
  normalizeAgentDisplayName,
} from "@aitne/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useChat, fetchSessionMessages } from "@/lib/hooks/use-chat";
import { useConfig } from "@/lib/hooks/use-config";
import { api, ApiError } from "@/lib/api-client";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ToolProgress } from "@/components/chat/tool-progress";
import { ChatInput } from "@/components/chat/chat-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Pencil, Save, ArrowLeft, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CharacterEditor,
  isCharacterOverCap,
} from "@/components/settings/character-editor";
import type { ChatMessage } from "@/lib/hooks/use-chat";
import type {
  MigrationErrorBody,
  MigrationOkResponse,
} from "@/lib/api-types";
import {
  readWizardState,
  writeWizardState,
  clearWizardState,
} from "@/lib/setup-storage";
import {
  buildVaultMigrationBody,
  decideVaultMigration,
  type VaultMode,
} from "./vault-step.logic";

// ── Types ──

interface ConversationStepProps {
  mode: "initial" | "update";
  agentDisplayName?: string;
  onComplete: () => void;
  /**
   * SETUP-FLOW-REDESIGN-PLAN §5.8 — Back button shown above the agent
   * conversation. The legacy Phase 1 (tool selections) is gone, so the
   * step mounts directly into the chat panel.
   */
  onBack?: () => void;
  /**
   * SETUP-FLOW-REDESIGN-PLAN §5.2 — the user's pending vault choice from
   * the Vault step. Holding these here (rather than committing on the
   * vault step) lets the user Back-navigate freely; the actual
   * `/setup/migrate-context` runs on mount of this step so files only
   * appear at the chosen path once setup is essentially done. Omitted in
   * `update` mode (no vault decision is being made).
   */
  pendingVaultMode?: VaultMode;
  pendingVaultPath?: string;
}

// ── Helpers ──

function extractRulesBlock(content: string): string | null {
  const match = content.match(/```management-rules\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

function extractCharacterBlock(content: string): string | null {
  const match = content.match(/```character\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

// Staged code blocks are rendered in the preview cards below. Replace them in
// the chat bubble so the same content isn't shown twice.
function stripStagedBlocksForDisplay(content: string): string {
  return content
    .replace(/```management-rules\n[\s\S]*?```/g, "_(management rules preview shown below ↓)_")
    .replace(/```character\n[\s\S]*?```/g, "_(character preview shown below ↓)_")
    .trim();
}

function extractChoices(content: string): string[] {
  const choices: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^- \*\*(.+?)\*\*/);
    if (match) choices.push(match[1]);
  }
  return choices.length >= 2 && choices.length <= 8 ? choices : [];
}

// ── Component ──

export function ConversationStep({
  mode,
  agentDisplayName,
  onComplete,
  onBack,
  pendingVaultMode,
  pendingVaultPath,
}: ConversationStepProps) {
  const { data: config } = useConfig();

  // SETUP-FLOW-REDESIGN-PLAN §5.8 — the legacy two-phase split is
  // gone; the step mounts directly into the chat panel. Persisted
  // wizard state (sessionStorage) still tracks `setupSessionId` for
  // reload-survival, but `phase` and `selections` are no longer
  // written or consumed here.

  // ── Chat state ──
  const {
    messages,
    restoredMessages,
    setRestoredMessages,
    streaming,
    toolProgress,
    sessionInfo,
    sendMessage,
  } = useChat({ disableHistory: true });
  const displayMessages = useMemo(
    () => [...restoredMessages, ...messages],
    [restoredMessages, messages],
  );
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  // Synchronous in-flight latch for the vault migration. State-based
  // checks (`if (migrating) return;`) don't dedupe under React 18
  // StrictMode (the dev double-invoke sees the same pre-setState value
  // and both invocations pass the gate). A ref flips synchronously on
  // the first run and blocks the second.
  const migrationInFlightRef = useRef(false);

  const [rulesContent, setRulesContent] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState("");
  const [saving, setSaving] = useState(false);
  const [waitingForReply, setWaitingForReply] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [startAttempt, setStartAttempt] = useState(0);

  // Mirror `streaming` into a ref so `handleSave` can poll its current value
  // without re-binding the callback on every chunk. Used by the bounded
  // drain-wait below — the user clicks Save while silent profile writes
  // may still be in flight, and we want to give them a brief chance to
  // land before /setup/save-rules deletes the live agent session.
  const streamingRef = useRef(streaming);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  // SETUP-FLOW-REDESIGN-PLAN §5.2 — vault migration runs HERE (not on
  // the Vault step), so the user's chosen folder stays untouched until
  // they commit by reaching this final step. `migrationReady` gates the
  // `/setup/start` effect below; in update mode (no vault decision) it
  // is true from the first render. `migrationAttempt` lets the user
  // retry after a transient failure (e.g. iCloud eviction) without
  // forcing them to back-nav.
  const [migrationReady, setMigrationReady] = useState<boolean>(
    mode === "update",
  );
  const [migrating, setMigrating] = useState<boolean>(false);
  const [migrationError, setMigrationError] = useState<
    MigrationErrorBody | null
  >(null);
  const [migrationAttempt, setMigrationAttempt] = useState(0);
  // Character is staged via a ```character``` code block from the agent. The
  // draft is what the user sees in the inline editor — seeded from the agent's
  // block, manually editable, committed to /api/config on Save & Finish.
  // `characterInitialized` tracks whether we've seeded the draft from either
  // the agent block or the current config, so user edits don't get clobbered
  // by a later block the agent emits during revisions.
  const [characterDraft, setCharacterDraft] = useState<string>("");
  const [characterInitialized, setCharacterInitialized] = useState(false);
  const [characterUserEdited, setCharacterUserEdited] = useState(false);
  const effectiveAgentDisplayName =
    mode === "initial"
      ? normalizeAgentDisplayName(agentDisplayName)
      : config?.agentDisplayName ?? DEFAULT_AGENT_DISPLAY_NAME;

  // Reset waitingForReply on new assistant / error message
  useEffect(() => {
    if (displayMessages.length === 0) return;
    const lastMsg = displayMessages[displayMessages.length - 1];
    if (lastMsg.role === "assistant" || lastMsg.role === "error") {
      setWaitingForReply(false);
    }
  }, [displayMessages]);

  // Safety timeout
  useEffect(() => {
    if (!waitingForReply) return;
    const timer = setTimeout(() => setWaitingForReply(false), 120_000);
    return () => clearTimeout(timer);
  }, [waitingForReply]);

  const isProcessing = waitingForReply || streaming;

  // Auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [displayMessages.length, toolProgress]);

  // SETUP-FLOW-REDESIGN-PLAN §5.2 — commit the user's vault choice now,
  // not earlier. The Vault step writes its picks into wizard state; this
  // effect calls `/setup/migrate-context` only when the daemon's current
  // config differs from those picks, then flips `migrationReady` so the
  // `/setup/start` effect below can run. A failed migration leaves
  // `migrationReady` false; the user sees a Retry / Back path instead of
  // a half-bound chat session.
  //
  // Known limitation: if the user reaches rules once (a dashboard_chat
  // session was created by `/setup/start`), back-navigates to Vault,
  // changes the path, then forwards back to rules, the daemon's
  // active-session guard inside `/setup/migrate-context` will respond
  // with 409 `sessions_active`. We surface the daemon's message via the
  // error UI; the user must close the tab to drop the session and
  // restart, or the daemon must restart (which sweeps stale chat
  // sessions). Resolving this cleanly would require a `/setup/abandon`
  // endpoint and is out of scope for the deferred-migration change.
  useEffect(() => {
    if (mode !== "initial") return;
    if (migrationReady) return;
    if (migrationInFlightRef.current) return;
    // Sticky-error guard: once a migration attempt errors, the effect
    // would otherwise re-fire (because `migrating` just flipped false)
    // and hammer the daemon in a loop. The user must click Retry, which
    // clears `migrationError` and increments `migrationAttempt`.
    if (migrationError) return;
    if (!config) return;

    const decision = decideVaultMigration({
      pendingMode: pendingVaultMode ?? "plain",
      pendingPath: pendingVaultPath ?? "",
      currentMode: config.vaultMode === "obsidian" ? "obsidian" : "plain",
      currentPath: config.primaryVaultPath ?? null,
    });

    if (decision.kind === "no_migration_needed") {
      setMigrationReady(true);
      return;
    }

    // Latch BEFORE any setState so a StrictMode double-invoke or rapid
    // dep re-fire is dropped at the synchronous gate above.
    migrationInFlightRef.current = true;
    setMigrating(true);
    setMigrationError(null);
    api
      .post<MigrationOkResponse>(
        "/setup/migrate-context",
        buildVaultMigrationBody({
          vaultMode: decision.mode,
          primaryVaultPath: decision.path,
        }),
      )
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: ["config"] });
        await queryClient.invalidateQueries({ queryKey: ["health"] });
        setMigrationReady(true);
      })
      .catch((err) => {
        if (err instanceof ApiError) {
          setMigrationError((err.body ?? {}) as MigrationErrorBody);
        } else {
          setMigrationError({
            error: "internal_error",
            message:
              err instanceof Error ? err.message : "Unexpected error.",
          });
        }
      })
      .finally(() => {
        migrationInFlightRef.current = false;
        setMigrating(false);
      });
  }, [
    mode,
    migrationReady,
    migrationError,
    config,
    pendingVaultMode,
    pendingVaultPath,
    queryClient,
    migrationAttempt,
  ]);

  // Start agent conversation when entering phase 2.
  //
  // Resume path: if a previous run persisted a `setupSessionId` AND the SSE
  // server bound the same id (it auto-adopts the still-`active`
  // dashboard_chat session via `findActiveDashboardSessionId`), skip
  // /setup/start and just refetch history. The daemon-startup sweep in
  // `index.ts` closes leftover dashboard_chat sessions on restart, so a
  // mismatched `sessionInfo.sessionId` after restart correctly falls
  // through to a fresh /setup/start instead of resuming a stale agent
  // state with no `currentSetupMode` server-side.
  useEffect(() => {
    if (startedRef.current || !sessionInfo?.channelId) return;
    // SETUP-FLOW-REDESIGN-PLAN §5.2 — block until vault migration
    // commits. In update mode `migrationReady` is true from the first
    // render so this is a no-op.
    if (!migrationReady) return;

    // Resume only when the persisted session id was created under THIS
    // mode — otherwise an `initial` setupSessionId left in storage from
    // an abandoned run would wrongly skip the fresh /setup/start the
    // current `update` flow needs.
    const persistedNow = readWizardState();
    const modeMatches = persistedNow.setupSessionMode === mode;
    const resumedSessionId =
      modeMatches
      && typeof persistedNow.setupSessionId === "number"
      && persistedNow.setupSessionId > 0
      && sessionInfo.sessionId === persistedNow.setupSessionId
        ? persistedNow.setupSessionId
        : null;

    if (resumedSessionId !== null) {
      startedRef.current = true;
      fetchSessionMessages(resumedSessionId)
        .then((restored) => {
          setRestoredMessages(restored);
        })
        .catch((err) => {
          // History fetch failed — the conversation is still resumable
          // through the live SSE stream, so don't surface a fatal error.
          console.warn("[setup] failed to refetch resumed session history", err);
        });
      return;
    }

    startedRef.current = true;
    setStartError(null);
    setWaitingForReply(true);

    // SETUP-FLOW-REDESIGN-PLAN §5.8 — `/setup/start` no longer takes
    // `selections`. The agent derives the Source-of-Truth table from
    // the integrations registry (steps 4–6 already configured those)
    // and asks the user only about rows it could not infer.
    api
      .post("/setup/start", {
        channelId: sessionInfo.channelId,
        mode,
        ...(mode === "initial"
          ? { agentDisplayName: effectiveAgentDisplayName }
          : {}),
      })
      .catch((err) => {
        startedRef.current = false;
        const msg = err instanceof Error ? err.message : "Failed to start setup";
        setStartError(msg);
        setWaitingForReply(false);
      });
  }, [
    sessionInfo?.channelId,
    sessionInfo?.sessionId,
    mode,
    effectiveAgentDisplayName,
    startAttempt,
    migrationReady,
    setRestoredMessages,
  ]);

  // Persist the in-flight setup session id once the dispatcher binds it.
  // On reload the resume effect above can verify it against the SSE-
  // adopted session and skip /setup/start. Tagging with the current
  // mode lets the resume effect reject a match that came from a
  // different mode's abandoned run.
  useEffect(() => {
    if (typeof sessionInfo?.sessionId !== "number") return;
    writeWizardState({
      setupSessionId: sessionInfo.sessionId,
      setupSessionMode: mode,
    });
  }, [mode, sessionInfo?.sessionId]);

  // Detect rules + character blocks in assistant messages. Walks back
  // from the most recent message so a revision overrides an earlier
  // draft. Runs during streaming too: the regex requires a closing
  // fence so partial blocks never match. Without this, the preview
  // would only appear after the agent's silent curl writes to
  // user/profile.md (+ optional user/*.md PATCHes) finish — the SDK
  // fires `onEnd` only when the whole turn drains, which is many
  // seconds later than the rules block actually arriving.
  useEffect(() => {
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      const msg = displayMessages[i];
      if (msg.role !== "assistant") continue;
      const rules = extractRulesBlock(msg.content);
      if (rules) {
        setRulesContent(rules);
        if (!editing) setEditBuffer(rules);
      }
      const character = extractCharacterBlock(msg.content);
      if (character !== null && !characterUserEdited) {
        setCharacterDraft(character);
        setCharacterInitialized(true);
      }
      if (rules || character !== null) break;
    }
  }, [displayMessages, editing, characterUserEdited]);

  // Seed the character draft from /api/config the first time the rules
  // preview appears, so the editor is never empty for an update-mode run
  // where the agent didn't emit a ```character``` block. Only runs once —
  // later agent revisions re-seed via the block-detector above, and explicit
  // user edits flip `characterUserEdited` which both branches respect.
  useEffect(() => {
    if (!rulesContent || characterInitialized) return;
    setCharacterDraft(config?.character ?? "");
    setCharacterInitialized(true);
  }, [rulesContent, characterInitialized, config?.character]);

  const handleSave = useCallback(async () => {
    const content = editing ? editBuffer : rulesContent;
    if (!content) return;
    const trimmedCharacter = characterDraft.trim();
    if (isCharacterOverCap(trimmedCharacter)) {
      setSaveError("Character exceeds the 1000-character cap.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      // The agent's silent curl writes (user/profile.md + optional
      // user/*.md PATCHes) follow the staged blocks in the same turn.
      // /setup/save-rules deletes the live agent session, which would
      // cut those writes off. Wait briefly for the stream to drain so
      // the writes land in the common case — but bound it so a hung
      // agent can never trap the user on a disabled-equivalent Save.
      // On timeout we proceed anyway; the skeleton seeder writes a
      // default user/profile.md and the user can flesh it out later.
      const DRAIN_TIMEOUT_MS = 15_000;
      const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
      while (streamingRef.current && Date.now() < drainDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // PATCH character first. If this fails, rules haven't been saved yet,
      // so the user can retry cleanly without the wizard advancing on half
      // a write. We only fire the PATCH when the draft actually differs from
      // the current config — avoids an inert write-lock row for no-op edits.
      const currentCharacter = config?.character ?? "";
      if (characterInitialized && trimmedCharacter !== currentCharacter) {
        await api.patch("/config", { character: trimmedCharacter });
      }
      await api.post("/setup/save-rules", {
        content,
        ...(mode === "initial"
          ? { agentDisplayName: effectiveAgentDisplayName }
          : {}),
        ...(typeof sessionInfo?.sessionId === "number"
          ? { sessionId: sessionInfo.sessionId }
          : {}),
      });
      // Optimistically set cache so Overview doesn't redirect back to /setup
      // (invalidateQueries only marks stale — the old needsSetup:true would be
      //  returned immediately on next mount, triggering a redirect loop)
      queryClient.setQueryData(["setup-status"], {
        needsSetup: false,
        completedAt: new Date().toISOString(),
      });
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["health"] });
      // Setup is committed — drop all persisted wizard state so a future
      // re-entry (re-setup or update mode) starts clean instead of
      // restoring stale step / selections / setupSessionId.
      clearWizardState();
      onComplete();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save rules");
    } finally {
      setSaving(false);
    }
  }, [
    editing,
    editBuffer,
    rulesContent,
    characterDraft,
    characterInitialized,
    config?.character,
    queryClient,
    onComplete,
    mode,
    effectiveAgentDisplayName,
    sessionInfo?.sessionId,
  ]);

  const handleChoiceClick = useCallback(
    (choice: string) => {
      sendMessage(choice);
      setWaitingForReply(true);
    },
    [sendMessage],
  );

  const handleSendMessage = useCallback(
    (content: string) => {
      sendMessage(content);
      setWaitingForReply(true);
    },
    [sendMessage],
  );

  const lastAssistantMsg = [...displayMessages].reverse().find((m) => m.role === "assistant");
  const choices = lastAssistantMsg && !isProcessing ? extractChoices(lastAssistantMsg.content) : [];

  // SETUP-FLOW-REDESIGN-PLAN §5.8 — Phase 1 (tool selections) is removed.
  // The Source-of-Truth table is derived inside the agent conversation
  // from the integrations registry; the wizard mounts directly into the
  // chat panel.

  // ══════════════════════════════════════════
  //  Phase 2: Agent Conversation (Claude Code)
  // ══════════════════════════════════════════
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col">
      <div className="space-y-1 px-4 pt-4 text-center">
        <h2 className="text-xl font-semibold">
          {mode === "initial" ? "Customize Your Rules" : "Update Management Rules"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {mode === "initial"
            ? "Chat with the agent — it will draft the management rules it follows on every task from your answers."
            : "Review the current rules and tell the agent what to change."}
        </p>
      </div>

      {migrating && (
        <Alert className="mx-4 mt-4 rounded-lg px-4 py-3 text-sm">
          <div className="flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Setting up your vault…</span>
          </div>
        </Alert>
      )}

      {migrationError && !migrating && (
        <Alert variant="error" className="mx-4 mt-4 rounded-lg px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-3 w-full">
            <div>
              <p className="font-medium">Could not set up your vault</p>
              <p className="mt-0.5">{migrationError.message}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              {onBack && (
                <Button size="sm" variant="ghost" onClick={onBack}>
                  Back
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setMigrationError(null);
                  setMigrationAttempt((prev) => prev + 1);
                }}
              >
                Retry
              </Button>
            </div>
          </div>
        </Alert>
      )}

      {startError && (
        <Alert variant="error" className="mx-4 mt-4 rounded-lg px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-3 w-full">
            <span>{startError}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setStartAttempt((prev) => prev + 1)}
            >
              Retry
            </Button>
          </div>
        </Alert>
      )}

      <ScrollArea ref={scrollRef} className="flex-1 px-4 py-4">
        <div className="space-y-4">
          {displayMessages.map((msg: ChatMessage) => (
            <MessageBubble
              key={msg.id}
              message={
                msg.role === "assistant"
                  ? { ...msg, content: stripStagedBlocksForDisplay(msg.content) }
                  : msg
              }
              assistantLabel={effectiveAgentDisplayName}
            />
          ))}
          <ToolProgress items={toolProgress} />
          {isProcessing && (
            <div className="flex justify-start">
              <span className="inline-block h-5 w-1 animate-pulse rounded-full bg-foreground" />
            </div>
          )}
          {displayMessages.length === 0
            && !isProcessing
            && !startError
            && !migrating
            && !migrationError && (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <p className="text-sm">Preparing setup...</p>
            </div>
          )}
        </div>
      </ScrollArea>

      {choices.length > 0 && !rulesContent && (
        <div className="flex flex-wrap gap-2 border-t border-border bg-muted/30 px-4 py-3">
          {choices.map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant="outline"
              onClick={() => handleChoiceClick(choice)}
              disabled={isProcessing}
              className="text-xs"
            >
              {choice}
            </Button>
          ))}
        </div>
      )}

      {rulesContent && (
        <div className="border-t border-border bg-muted/30 px-4 py-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Management Rules Preview</h3>
            <div className="flex items-center gap-2">
              {isProcessing && !saving && (
                // Informational hint while the agent's silent user/profile +
                // user/*.md writes finish. Save is enabled — clicking it
                // briefly waits for the stream to drain so those writes
                // land, then proceeds (bounded; see DRAIN_TIMEOUT_MS in
                // handleSave) so a hung agent never traps the user.
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Finalizing your profile…
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (editing) setEditBuffer(rulesContent);
                  setEditing(!editing);
                }}
                className="gap-1 text-xs"
              >
                <Pencil className="h-3 w-3" />
                {editing ? "Cancel" : "Edit"}
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving || isCharacterOverCap(characterDraft)}
                className="gap-1"
              >
                {saving ? (
                  "Saving..."
                ) : (
                  <>
                    <Save className="h-3.5 w-3.5" />
                    Save & Finish
                  </>
                )}
              </Button>
            </div>
          </div>

          {saveError && <Alert variant="error">{saveError}</Alert>}

          {editing ? (
            <textarea
              value={editBuffer}
              onChange={(e) => setEditBuffer(e.target.value)}
              className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
              rows={16}
            />
          ) : (
            <pre className="max-h-96 overflow-auto rounded-md border border-border bg-background p-3 text-xs leading-relaxed">
              {rulesContent}
            </pre>
          )}

          <div className="space-y-2 border-t border-border/60 pt-4">
            <div>
              <h3 className="text-sm font-medium">Character</h3>
              <p className="text-xs text-muted-foreground">
                Tone, formality, and verbal habits the agent should keep
                across every session and backend. Leave blank to skip.
              </p>
            </div>
            <CharacterEditor
              value={characterDraft}
              onChange={(next) => {
                setCharacterDraft(next);
                setCharacterUserEdited(true);
                if (!characterInitialized) setCharacterInitialized(true);
              }}
              disabled={saving}
              rows={4}
            />
          </div>
        </div>
      )}

      {!saving && (
        <ChatInput
          onSend={handleSendMessage}
          disabled={isProcessing || displayMessages.length === 0}
        />
      )}
    </div>
  );
}
