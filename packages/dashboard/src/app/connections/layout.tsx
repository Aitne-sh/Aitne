import type { ReactNode } from "react";
import { ConnectionsNavigation } from "@/components/connections/connections-navigation";

export default function ConnectionsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6 md:flex-row md:items-start md:gap-8">
      <aside className="md:sticky md:top-6">
        <ConnectionsNavigation />
      </aside>
      <div className="min-w-0 flex-1 space-y-6">{children}</div>
    </div>
  );
}
