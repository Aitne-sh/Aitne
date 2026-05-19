export default function KnowledgeLoading() {
  return (
    <div className="flex h-full flex-col p-6">
      <div className="h-7 w-40 animate-pulse rounded bg-muted/40" />
      <div className="mt-2 mb-5 h-4 w-3/4 animate-pulse rounded bg-muted/30" />
      <div className="mb-4 flex gap-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-9 w-28 animate-pulse rounded bg-muted/40" />
        ))}
      </div>
      <div className="flex-1 animate-pulse rounded-lg bg-muted/20" />
    </div>
  );
}
