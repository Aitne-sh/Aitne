"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  FolderOpen,
  GitBranch,
  Github,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Search,
  Trash2,
  Unlink,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { DirectoryPickerField } from "@/components/directory-picker-field";
import {
  type RepositoryCategory,
  type RepositoryClassification,
  type RepositoryDTO,
  type RepositoryLocalProbeResult,
  type RepositoryUpdateInput,
  repositoryLocalProbeSummary,
  repositoryDisplayName,
  repositoryHasGithub,
  repositoryHasLocal,
  useDeleteRepository,
  useLinkGithub,
  useLinkLocal,
  useProbeRepositoryLocal,
  useUpdateRepository,
} from "@/lib/hooks/use-repositories";
import { useGitAccounts } from "@/lib/hooks/use-git-accounts";

const FIELD_LABEL = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground";

const CLASSIFICATIONS: RepositoryClassification[] = ["project", "repo-only"];
const CATEGORIES: RepositoryCategory[] = [
  "work",
  "personal",
  "research",
  "client",
  "other",
];

type ProbeNotice = {
  tone: "success" | "info" | "error";
  text: string;
} | null;

function probeNoticeClass(tone: NonNullable<ProbeNotice>["tone"]): string {
  if (tone === "success") {
    return "border-success/30 bg-success/10 text-success";
  }
  if (tone === "error") {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  return "border-border bg-muted/40 text-muted-foreground";
}

export function RepositoryCard({ repo }: { repo: RepositoryDTO }) {
  const [editing, setEditing] = useState(false);
  const [linkingGithub, setLinkingGithub] = useState(false);
  const [linkingLocal, setLinkingLocal] = useState(false);
  const deleteMutation = useDeleteRepository();
  const updateMutation = useUpdateRepository();
  const confirm = useConfirm();

  const hasGithub = repositoryHasGithub(repo);
  const hasLocal = repositoryHasLocal(repo);
  const localOnly = repo.localOnly;

  const handleDelete = async () => {
    const ok = await confirm({
      title: `Delete ${repositoryDisplayName(repo)}?`,
      description:
        "This removes the repository registration along with its triggers and management state. The local clone on disk is not touched.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    await deleteMutation.mutateAsync(repo.id);
  };

  const toggleLocalOnly = async (next: boolean) => {
    if (next && hasGithub) {
      const ok = await confirm({
        title: "Mark as local-only?",
        description:
          "This will clear the GitHub link. To keep both sides, leave 'local-only' off.",
        confirmLabel: "Mark local-only",
      });
      if (!ok) return;
      await updateMutation.mutateAsync({
        id: repo.id,
        body: {
          localOnly: true,
          githubOwner: null,
          githubRepo: null,
          githubAccount: null,
        },
      });
    } else {
      await updateMutation.mutateAsync({
        id: repo.id,
        body: { localOnly: next },
      });
    }
  };

  const unlinkLocal = async () => {
    if (!hasGithub) {
      // Cannot leave the row with neither side; surface this as a confirm dialog
      // and refuse via the API (which returns the same error).
      await confirm({
        title: "Cannot unlink the local clone",
        description:
          "This row has no GitHub side, so unlinking would leave it empty. Delete the repository instead.",
        confirmLabel: "OK",
      });
      return;
    }
    const ok = await confirm({
      title: "Unlink local clone?",
      description: `The clone at ${repo.localPath} stays on disk; only the registration is detached.`,
      confirmLabel: "Unlink",
    });
    if (!ok) return;
    await updateMutation.mutateAsync({ id: repo.id, body: { localPath: null } });
  };

  const unlinkGithub = async () => {
    const ok = await confirm({
      title: "Unlink GitHub remote?",
      description: hasLocal
        ? "The local clone stays registered."
        : "This row has no local clone, so unlinking would leave it empty. Use 'Mark local-only' instead.",
      confirmLabel: "Unlink",
    });
    if (!ok) return;
    if (!hasLocal) return;
    await updateMutation.mutateAsync({
      id: repo.id,
      body: { githubOwner: null, githubRepo: null, githubAccount: null },
    });
  };

  return (
    <Card>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-foreground">
              {repositoryDisplayName(repo)}
            </span>
            {localOnly && (
              <Badge variant="gray" className="text-[10px]">
                <Lock className="mr-1 h-3 w-3" />
                local-only
              </Badge>
            )}
            <Badge variant={repo.classification === "project" ? "green" : "gray"}>
              {repo.classification}
            </Badge>
            <Badge variant="gray">{repo.category}</Badge>
          </div>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">{repo.id}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={handleDelete} title="Delete">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Body — two-column GitHub / Local layout */}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {/* GitHub side */}
        <div className="rounded-md border bg-background/40 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Github className="h-3.5 w-3.5" />
            GitHub
          </div>
          {hasGithub ? (
            <div className="mt-1 space-y-1 text-sm">
              <p className="font-medium">
                {repo.githubOwner}/{repo.githubRepo}
              </p>
              <p className="text-[11px] text-muted-foreground">
                account: {repo.githubAccount ?? "default"}
              </p>
              {hasLocal && !localOnly && (
                <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={unlinkGithub}>
                  <Unlink className="mr-1 h-3 w-3" />
                  Unlink
                </Button>
              )}
            </div>
          ) : localOnly ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Local-only — toggle off to enable GitHub linking.
            </p>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-8"
              onClick={() => setLinkingGithub(true)}
            >
              <Plus className="mr-1 h-3 w-3" />
              Link GitHub remote
            </Button>
          )}
        </div>

        {/* Local clone side */}
        <div className="rounded-md border bg-background/40 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <FolderOpen className="h-3.5 w-3.5" />
            Local clone
          </div>
          {hasLocal ? (
            <div className="mt-1 space-y-1 text-sm">
              <p className="truncate font-medium" title={repo.localPath ?? ""}>
                {repo.localPath}
              </p>
              <p className="text-[11px] text-muted-foreground">
                slug: <span className="font-mono">{repo.slug}</span>
              </p>
              {hasGithub && (
                <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={unlinkLocal}>
                  <Unlink className="mr-1 h-3 w-3" />
                  Unlink
                </Button>
              )}
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-8"
              onClick={() => setLinkingLocal(true)}
            >
              <Plus className="mr-1 h-3 w-3" />
              Link local clone
            </Button>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={localOnly}
            disabled={updateMutation.isPending}
            onChange={(e) => void toggleLocalOnly(e.target.checked)}
          />
          Local-only repository
        </label>
        <Link
          href="/git"
          className="flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
        >
          Configure polling &amp; triggers in my life › git
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      <RepositoryEditSheet
        repo={repo}
        open={editing}
        onClose={() => setEditing(false)}
      />
      <LinkGithubSheet
        repo={repo}
        open={linkingGithub}
        onClose={() => setLinkingGithub(false)}
      />
      <LinkLocalSheet
        repo={repo}
        open={linkingLocal}
        onClose={() => setLinkingLocal(false)}
      />
    </Card>
  );
}

// ── Edit metadata sheet ──

// Wrapper keeps the Sheet root mounted across open→closed so Radix can clear
// its body pointer-events lock. Inner content is gated by `open` so form state
// re-initializes each time the sheet is reopened.
function RepositoryEditSheet({
  repo,
  open,
  onClose,
}: {
  repo: RepositoryDTO;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      {open && <RepositoryEditSheetContent repo={repo} onClose={onClose} />}
    </Sheet>
  );
}

function RepositoryEditSheetContent({
  repo,
  onClose,
}: {
  repo: RepositoryDTO;
  onClose: () => void;
}) {
  const update = useUpdateRepository();
  const [displayName, setDisplayName] = useState(repo.displayName ?? "");
  const [classification, setClassification] = useState<RepositoryClassification>(
    repo.classification,
  );
  const [category, setCategory] = useState<RepositoryCategory>(repo.category);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const body: RepositoryUpdateInput = {
        displayName: displayName.trim() ? displayName.trim() : null,
        classification,
        category,
      };
      await update.mutateAsync({ id: repo.id, body });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes");
    }
  };

  return (
    <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Edit repository metadata</SheetTitle>
        </SheetHeader>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <label className={FIELD_LABEL}>Display name</label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={repositoryDisplayName(repo)}
            />
            <p className="text-[11px] text-muted-foreground">
              Optional — drives the slug used for context paths and dashboard deep-links.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className={FIELD_LABEL}>Classification</label>
            <select
              value={classification}
              onChange={(e) =>
                setClassification(e.target.value as RepositoryClassification)
              }
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              {CLASSIFICATIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Project entries carry lifecycle phases in the overview MD; repo-only
              stays lightweight.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className={FIELD_LABEL}>Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as RepositoryCategory)}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </SheetContent>
  );
}

// ── Link GitHub remote sheet ──

function LinkGithubSheet({
  repo,
  open,
  onClose,
}: {
  repo: RepositoryDTO;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      {open && <LinkGithubSheetContent repo={repo} onClose={onClose} />}
    </Sheet>
  );
}

function LinkGithubSheetContent({
  repo,
  onClose,
}: {
  repo: RepositoryDTO;
  onClose: () => void;
}) {
  const link = useLinkGithub();
  const probeLocal = useProbeRepositoryLocal();
  const { data: accounts } = useGitAccounts();
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [account, setAccount] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [probeNotice, setProbeNotice] = useState<ProbeNotice>(null);

  const probeFromLocalClone = async () => {
    if (!repo.localPath) return;
    setError(null);
    try {
      const result = await probeLocal.mutateAsync(repo.localPath);
      if (result.detected) {
        setOwner(result.githubOwner);
        setName(result.githubRepo);
        setProbeNotice({
          tone: "success",
          text: `${repositoryLocalProbeSummary(result)} Owner and repository were filled from the local clone.`,
        });
        return;
      }
      setProbeNotice({
        tone: "info",
        text: `${repositoryLocalProbeSummary(result)} Enter the GitHub owner and repository manually.`,
      });
    } catch (err) {
      setProbeNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "Failed to inspect local clone",
      });
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!owner.trim() || !name.trim()) {
      setError("owner and repo are required");
      return;
    }
    try {
      await link.mutateAsync({
        id: repo.id,
        owner: owner.trim(),
        repo: name.trim(),
        account: account.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link");
    }
  };

  return (
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Link a GitHub remote</SheetTitle>
        </SheetHeader>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <p className="text-xs text-muted-foreground">
            Personal accounts on github.com only. GHES is not in scope for v1.
          </p>
          {repo.localPath && (
            <div className="space-y-2 rounded-md border bg-background/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs text-muted-foreground" title={repo.localPath}>
                  Local clone: {repo.localPath}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void probeFromLocalClone()}
                  disabled={probeLocal.isPending}
                  className="shrink-0 gap-1.5"
                >
                  {probeLocal.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                  Detect
                </Button>
              </div>
              {probeNotice && (
                <p className={`rounded-md border p-2 text-xs ${probeNoticeClass(probeNotice.tone)}`}>
                  {probeNotice.text}
                </p>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <label className={FIELD_LABEL}>Owner</label>
              <Input
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="acme"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label className={FIELD_LABEL}>Repository</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="widgets"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className={FIELD_LABEL}>Account alias</label>
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="">default</option>
              {(accounts?.accounts ?? []).map((a) => (
                <option key={a.alias} value={a.alias}>
                  {a.alias}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={link.isPending}>
              {link.isPending ? "Linking…" : "Link"}
            </Button>
          </div>
        </form>
      </SheetContent>
  );
}

// ── Link local clone sheet ──

function LinkLocalSheet({
  repo,
  open,
  onClose,
}: {
  repo: RepositoryDTO;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      {open && <LinkLocalSheetContent repo={repo} onClose={onClose} />}
    </Sheet>
  );
}

function LinkLocalSheetContent({
  repo,
  onClose,
}: {
  repo: RepositoryDTO;
  onClose: () => void;
}) {
  const link = useLinkLocal();
  const probeLocal = useProbeRepositoryLocal();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<{
    path: string;
    result: RepositoryLocalProbeResult;
    notice: NonNullable<ProbeNotice>;
  } | null>(null);

  const expectedFullName = repo.githubOwner && repo.githubRepo
    ? `${repo.githubOwner}/${repo.githubRepo}`
    : null;
  const currentProbe = probe?.path === path.trim() ? probe : null;
  const probeMismatch = Boolean(
    expectedFullName
      && currentProbe
      && currentProbe.result.detected
      && currentProbe.result.fullName.toLowerCase() !== expectedFullName.toLowerCase(),
  );

  const probeLocalPath = async (value: string = path) => {
    const nextPath = value.trim();
    if (!nextPath) {
      setProbe(null);
      return;
    }
    setError(null);
    try {
      const result = await probeLocal.mutateAsync(nextPath);
      if (
        expectedFullName
        && result.detected
        && result.fullName.toLowerCase() !== expectedFullName.toLowerCase()
      ) {
        setProbe({
          path: nextPath,
          result,
          notice: {
            tone: "error",
            text: `Selected clone points to ${result.fullName}, but this row is ${expectedFullName}.`,
          },
        });
        return;
      }
      setProbe({
        path: nextPath,
        result,
        notice: {
          tone: result.detected ? "success" : "info",
          text: repositoryLocalProbeSummary(result),
        },
      });
    } catch (err) {
      setProbe({
        path: nextPath,
        result: {
          detected: false,
          localPath: nextPath,
          reason: "git_failed",
        },
        notice: {
          tone: "error",
          text: err instanceof Error ? err.message : "Failed to inspect local clone",
        },
      });
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!path.trim()) {
      setError("Local path is required");
      return;
    }
    if (probeMismatch) {
      setError("Selected local clone does not match this GitHub repository.");
      return;
    }
    try {
      await link.mutateAsync({ id: repo.id, localPath: path.trim() });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link");
    }
  };

  return (
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Link a local clone</SheetTitle>
        </SheetHeader>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <p className="text-xs text-muted-foreground">
            Pick the directory of the local clone of this repository. The
            origin remote is checked when a path is selected.
          </p>
          <div className="space-y-1.5">
            <label className={FIELD_LABEL}>Repository directory</label>
            <DirectoryPickerField
              value={path}
              onChange={(next) => {
                setPath(next);
                setProbe(null);
              }}
              onCommit={(next) => void probeLocalPath(next)}
              title="Choose local clone directory"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Check origin before linking to avoid pairing the wrong clone.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void probeLocalPath()}
              disabled={!path.trim() || probeLocal.isPending}
              className="shrink-0 gap-1.5"
            >
              {probeLocal.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              Check
            </Button>
          </div>
          {probe && (
            <p className={`rounded-md border p-2 text-xs ${probeNoticeClass(probe.notice.tone)}`}>
              {probe.notice.text}
            </p>
          )}
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={link.isPending}>
              {link.isPending ? "Linking…" : "Link"}
            </Button>
          </div>
        </form>
      </SheetContent>
  );
}
