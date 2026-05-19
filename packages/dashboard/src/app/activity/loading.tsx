export default function ActivityLoading() {
  return (
    <div className="flex h-full flex-col p-6">
      <div className="h-7 w-32 animate-pulse rounded bg-muted/40" />
      <div className="mt-2 mb-5 h-4 w-1/2 animate-pulse rounded bg-muted/30" />
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-lg bg-muted/20"
          />
        ))}
      </div>
    </div>
  );
}
