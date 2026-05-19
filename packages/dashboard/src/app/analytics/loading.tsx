export default function AnalyticsLoading() {
  return (
    <div className="flex min-h-full flex-col p-6 pb-8">
      <div className="h-7 w-40 animate-pulse rounded bg-muted/40" />
      <div className="mt-2 mb-5 h-4 w-3/4 animate-pulse rounded bg-muted/30" />
      <div className="mb-4 flex gap-1">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-9 w-20 animate-pulse rounded bg-muted/40" />
        ))}
      </div>
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl border border-border bg-muted/30"
            />
          ))}
        </div>
        <div className="h-72 animate-pulse rounded-xl border border-border bg-muted/30" />
      </div>
    </div>
  );
}
