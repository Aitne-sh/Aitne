"use client";

import { use } from "react";
import { DocsShell } from "@/components/docs/docs-shell";

export default function DocsPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = use(params);
  const selectedSlug = slug && slug.length > 0 ? slug.join("/") : null;
  return <DocsShell selectedSlug={selectedSlug} />;
}
