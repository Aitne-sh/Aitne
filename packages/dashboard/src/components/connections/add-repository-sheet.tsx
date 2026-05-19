"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DirectoryPickerField } from "@/components/directory-picker-field";
import { useGitAccounts } from "@/lib/hooks/use-git-accounts";
import {
  type RepositoryCategory,
  type RepositoryClassification,
  type RepositoryCreateInput,
  useCreateRepository,
} from "@/lib/hooks/use-repositories";

const FIELD_LABEL =
  "text-[11px] font-medium uppercase tracking-wider text-muted-foreground";
const FIELD_HINT = "text-[11px] leading-relaxed text-muted-foreground";
const SECTION_TITLE =
  "text-[11px] font-medium uppercase tracking-wider text-muted-foreground";

type Mode = "github" | "local" | "both";

const MODE_OPTIONS: Array<{
  value: Mode;
  label: string;
  description: string;
}> = [
  {
    value: "both",
    label: "GitHub + local clone",
    description:
      "Recommended. Agent watches GitHub activity AND reads files from your local clone.",
  },
  {
    value: "github",
    label: "GitHub only",
    description:
      "Agent watches PRs, issues, and commits on GitHub. No access to source files.",
  },
  {
    value: "local",
    label: "Local folder only",
    description:
      "Agent watches a folder on this Mac. No GitHub remote — e.g. a private working directory.",
  },
];

const CLASSIFICATION_OPTIONS: Array<{
  value: RepositoryClassification;
  label: string;
  description: string;
}> = [
  {
    value: "repo-only",
    label: "Just track activity",
    description:
      "Lightweight. Agent logs commits, PRs, and issues. No long-form project document.",
  },
  {
    value: "project",
    label: "Treat as a project",
    description:
      "Agent maintains a rich project document with goals, decisions, and milestones in your context notes.",
  },
];

const CATEGORIES: RepositoryCategory[] = [
  "work",
  "personal",
  "research",
  "client",
  "other",
];

// Wrapper keeps the Sheet root mounted across open→closed so Radix can clear
// its body pointer-events lock. Inner content is gated by `open` so form state
// re-initializes each time the sheet is reopened.
export function AddRepositorySheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      {open && <AddRepositorySheetContent onClose={onClose} />}
    </Sheet>
  );
}

function AddRepositorySheetContent({ onClose }: { onClose: () => void }) {
  const create = useCreateRepository();
  const { data: accounts } = useGitAccounts();
  const [mode, setMode] = useState<Mode>("both");
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [account, setAccount] = useState("");
  const [path, setPath] = useState("");
  const [localOnly, setLocalOnly] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [classification, setClassification] =
    useState<RepositoryClassification>("repo-only");
  const [category, setCategory] = useState<RepositoryCategory>("other");
  const [error, setError] = useState<string | null>(null);

  const showGithubFields = mode === "github" || (mode === "both" && !localOnly);
  const showLocalFields = mode === "local" || mode === "both";
  const showLocalOnlyToggle = mode === "local";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const body: RepositoryCreateInput = {
      classification,
      category,
      displayName: displayName.trim() ? displayName.trim() : undefined,
    };

    if (showGithubFields) {
      if (!owner.trim() || !name.trim()) {
        setError("GitHub owner and repository are required.");
        return;
      }
      body.githubOwner = owner.trim();
      body.githubRepo = name.trim();
      if (account.trim()) body.githubAccount = account.trim();
    }
    if (showLocalFields) {
      if (!path.trim()) {
        setError("Local clone path is required.");
        return;
      }
      body.localPath = path.trim();
    }
    if (mode === "local" && localOnly) {
      body.localOnly = true;
    }

    try {
      await create.mutateAsync(body);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add repository");
    }
  };

  const accountList = accounts?.accounts ?? [];

  return (
    <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Add repository</SheetTitle>
          <p className="text-xs text-muted-foreground">
            Tell the agent about a code repository to watch. It will track
            activity (commits, PRs, issues) and optionally maintain a project
            document in your context notes.
          </p>
        </SheetHeader>
        <form onSubmit={submit} className="mt-6 space-y-6">
          <div className="space-y-2">
            <label className={FIELD_LABEL}>Where does this repository live?</label>
            <div className="grid gap-2">
              {MODE_OPTIONS.map((option) => {
                const selected = mode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setMode(option.value)}
                    className={
                      "rounded-md border px-3 py-2 text-left transition-colors " +
                      (selected
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-accent")
                    }
                  >
                    <div
                      className={
                        "text-sm font-medium " +
                        (selected ? "text-primary" : "text-foreground")
                      }
                    >
                      {option.label}
                    </div>
                    <div className={FIELD_HINT + " mt-0.5"}>
                      {option.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {showGithubFields && (
            <div className="space-y-3 rounded-md border bg-background/40 p-3">
              <div className="space-y-1">
                <p className={SECTION_TITLE}>GitHub remote</p>
                <p className={FIELD_HINT}>
                  From the GitHub URL{" "}
                  <code className="rounded bg-muted px-1 py-px text-[10px]">
                    github.com/acme/widgets
                  </code>
                  , the owner is <strong>acme</strong> and the repository is{" "}
                  <strong>widgets</strong>.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className={FIELD_LABEL}>Owner (user or org)</label>
                  <Input
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder="acme"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={FIELD_LABEL}>Repository name</label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="widgets"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className={FIELD_LABEL}>GitHub account to use</label>
                <select
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                >
                  <option value="">default</option>
                  {accountList.map((a) => (
                    <option key={a.alias} value={a.alias}>
                      {a.alias}
                    </option>
                  ))}
                </select>
                <p className={FIELD_HINT}>
                  Which set of GitHub credentials the agent should use to read
                  this repo.{" "}
                  {accountList.length === 0
                    ? "Only the default account is set up — manage more under Connections → GitHub accounts."
                    : "Manage accounts under Connections → GitHub accounts."}
                </p>
              </div>
            </div>
          )}

          {showLocalFields && (
            <div className="space-y-3 rounded-md border bg-background/40 p-3">
              <div className="space-y-1">
                <p className={SECTION_TITLE}>Local clone</p>
                <p className={FIELD_HINT}>
                  Folder on this Mac where the repo is checked out. The agent
                  reads source files, commits, and uncommitted changes from
                  here.
                </p>
              </div>
              <DirectoryPickerField
                value={path}
                onChange={setPath}
                title="Choose local clone directory"
              />
              {showLocalOnlyToggle && (
                <label className="flex items-start gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={localOnly}
                    onChange={(e) => setLocalOnly(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    This folder is not (and will never be) backed by a GitHub
                    remote. Skip GitHub linking permanently.
                  </span>
                </label>
              )}
            </div>
          )}

          <div className="space-y-3 rounded-md border bg-background/40 p-3">
            <p className={SECTION_TITLE}>Naming &amp; tracking</p>
            <div className="space-y-1.5">
              <label className={FIELD_LABEL}>Display name (optional)</label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Leave blank to use the repo or folder name"
              />
              <p className={FIELD_HINT}>
                How this repository appears in the dashboard and in your
                context notes.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className={FIELD_LABEL}>How should the agent treat this?</label>
              <div className="grid gap-2">
                {CLASSIFICATION_OPTIONS.map((option) => {
                  const selected = classification === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setClassification(option.value)}
                      className={
                        "rounded-md border px-3 py-2 text-left transition-colors " +
                        (selected
                          ? "border-primary bg-primary/10"
                          : "border-border hover:bg-accent")
                      }
                    >
                      <div
                        className={
                          "text-sm font-medium " +
                          (selected ? "text-primary" : "text-foreground")
                        }
                      >
                        {option.label}
                      </div>
                      <div className={FIELD_HINT + " mt-0.5"}>
                        {option.description}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className={FIELD_LABEL}>Category (tag)</label>
              <select
                value={category}
                onChange={(e) =>
                  setCategory(e.target.value as RepositoryCategory)
                }
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <p className={FIELD_HINT}>
                Used to group repositories in the dashboard. Pick whichever
                feels right.
              </p>
            </div>
          </div>

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50/50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Adding…" : "Add repository"}
            </Button>
          </div>
        </form>
      </SheetContent>
  );
}
