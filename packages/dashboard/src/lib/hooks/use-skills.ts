"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  SkillDetail,
  SkillListResponse,
  SkillWriteResponse,
} from "@/lib/api-types";

/** List all skills (built-in + user). User skills come first. */
export function useSkills() {
  return useQuery({
    queryKey: ["skills"],
    queryFn: () => api.get<SkillListResponse>("/skills"),
  });
}

/** Read one skill's full content. Works for both built-in and user. */
export function useSkill(name: string | null) {
  return useQuery({
    queryKey: ["skill", name],
    queryFn: () => api.get<SkillDetail>(`/skills/${name}`),
    enabled: !!name,
  });
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description: string; content: string; allowedTools?: string[] }) =>
      api.post<SkillWriteResponse>("/skills", input),
    onSuccess: (_data, input) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["skill", input.name] });
    },
  });
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, ...body }: { name: string; description?: string; content?: string; allowedTools?: string[] }) =>
      api.put<SkillWriteResponse>(`/skills/${name}`, body),
    onSuccess: (_data, input) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["skill", input.name] });
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.delete<SkillWriteResponse>(`/skills/${name}`),
    onSuccess: (_data, name) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.removeQueries({ queryKey: ["skill", name] });
    },
  });
}

export function useUploadSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, name }: { file: File; name?: string }) => {
      const form = new FormData();
      form.append("file", file);
      if (name) form.append("name", name);
      return fetch("/api/skills/upload", {
        method: "POST",
        body: form,
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            (body as { error?: string } | null)?.error ??
              `Upload failed (${res.status})`,
          );
        }
        return res.json() as Promise<SkillWriteResponse>;
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}
