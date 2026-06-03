"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NewAgentForm } from "@/components/agents/NewAgentForm";
import { UserAgentYamlEditor } from "@/components/agents/AgentEditor";
import { useAgents, useSaveUserAgent } from "@/lib/hooks/use-agents";
import { scaffoldUserAgentMarkdown, slugFromMarkdown } from "@/lib/agents/yaml-edit";

/**
 * "+ New Agent" dialog (§10.1). Defaults to a field-based form so the operator
 * fills in name / description / schedule / backend / limits / prompt through
 * plain inputs instead of hand-authoring YAML. An "Advanced (YAML)" toggle
 * reveals the raw `agent.md` editor for the long-tail fields the form doesn't
 * expose (tags, success_criteria, tools, on_error, stop_warning).
 *
 * Both modes save through the same context-vault PUT chokepoint (the only legal
 * definition write path) and navigate to the new Agent's detail page; the
 * daemon's watcher imports the file and the page refreshes via SSE.
 */
type Mode = "form" | "yaml";

export function NewAgentDialog({ trigger }: { trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("form");
  const save = useSaveUserAgent();
  const router = useRouter();
  const [slugError, setSlugError] = useState<string | null>(null);

  // Existing slugs (built-in + user) — the form rejects a colliding id before a
  // PUT can overwrite another Agent's agent.md.
  const { data } = useAgents({ include_invalid: true });
  const existingSlugs = useMemo(
    () => (data?.agents ?? []).map((a) => a.slug),
    [data?.agents],
  );

  const saveAndGo = (content: string, slug: string) => {
    setSlugError(null);
    save.mutate(
      { slug, content },
      {
        onSuccess: () => {
          setOpen(false);
          router.push(`/agents/${slug}`);
        },
      },
    );
  };

  const handleYamlSave = (content: string) => {
    setSlugError(null);
    const slug = slugFromMarkdown(content);
    if (!slug) {
      setSlugError("The definition must declare a `slug:` field.");
      return;
    }
    saveAndGo(content, slug);
  };

  const reset = () => {
    setSlugError(null);
    setMode("form");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Agent</DialogTitle>
          <DialogDescription>
            {mode === "form" ? (
              <>
                Fill in the fields below to create a User Agent. Saving writes{" "}
                <code>policies/agents/&lt;id&gt;/agent.md</code> through the context vault.
              </>
            ) : (
              <>
                Define a user Agent in YAML. The <code>slug</code> becomes its URL and directory
                name. Saving writes <code>policies/agents/&lt;slug&gt;/agent.md</code> through the
                context vault.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Form / Advanced toggle */}
        <div className="mb-3 flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={mode === "form" ? "default" : "outline"}
            onClick={() => setMode("form")}
            aria-pressed={mode === "form"}
          >
            Form
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "yaml" ? "default" : "outline"}
            onClick={() => setMode("yaml")}
            aria-pressed={mode === "yaml"}
          >
            Advanced (YAML)
          </Button>
        </div>

        {mode === "form" ? (
          <NewAgentForm
            saving={save.isPending}
            saveError={slugError ?? (save.isError ? (save.error as Error).message : null)}
            existingSlugs={existingSlugs}
            onSave={saveAndGo}
            onCancel={() => setOpen(false)}
          />
        ) : (
          <UserAgentYamlEditor
            initialContent={scaffoldUserAgentMarkdown("my-agent")}
            saving={save.isPending}
            saveError={slugError ?? (save.isError ? (save.error as Error).message : null)}
            onSave={handleYamlSave}
            onCancel={() => setOpen(false)}
            allowUnchanged
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
