// Route-segment Suspense fallback. Renders instantly when the user
// navigates to /docs/* so the previous page is replaced by a skeleton
// rather than staying painted while the new tree commits.
export default function DocsLoading() {
  return (
    <div className="grid h-full min-h-0 grid-cols-[220px_1fr] xl:grid-cols-[220px_1fr_360px]">
      <aside className="space-y-2 border-r border-border bg-muted/30 p-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className="h-6 animate-pulse rounded bg-muted/50"
            style={{ width: `${60 + ((i * 17) % 35)}%` }}
          />
        ))}
      </aside>
      <main className="overflow-hidden px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-3">
          <div className="h-8 w-1/2 animate-pulse rounded bg-muted/40" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted/30" />
          <div className="space-y-2 pt-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-4 animate-pulse rounded bg-muted/20"
                style={{ width: `${70 + ((i * 13) % 25)}%` }}
              />
            ))}
          </div>
        </div>
      </main>
      <aside className="hidden border-l border-border bg-muted/20 xl:block" />
    </div>
  );
}
