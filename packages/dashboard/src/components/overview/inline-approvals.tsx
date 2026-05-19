"use client";

import { useApprovals, useApproveAction, useDenyAction } from "@/lib/hooks/use-approvals";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatShortDateTime, formatAbsoluteTime, formatRelativeTime } from "@/lib/utils";
import { AlertTriangle, Check, X } from "lucide-react";

export function InlineApprovals() {
  const { data } = useApprovals();
  const approveAction = useApproveAction();
  const denyAction = useDenyAction();
  const confirm = useConfirm();

  const approvals = data?.approvals ?? [];
  if (approvals.length === 0) return null;

  const handleDeny = async (id: number, description: string) => {
    const ok = await confirm({
      title: "Deny this approval?",
      description: `"${description}" will be permanently denied.`,
      confirmLabel: "Deny",
      variant: "destructive",
    });
    if (ok) denyAction.mutate(id);
  };

  return (
    <Card tone="warning">
      <CardHeader className="mb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          {approvals.length} pending approval{approvals.length !== 1 ? "s" : ""}
        </CardTitle>
      </CardHeader>
      <div className="space-y-3">
        {approvals.map((approval) => (
          <div key={approval.id} className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{approval.task_description}</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="blue" className="text-[10px]">{approval.task_type}</Badge>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="font-mono tabular-nums">{formatShortDateTime(approval.created_at)}</span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {formatAbsoluteTime(approval.created_at)} ({formatRelativeTime(approval.created_at)})
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button
                size="sm"
                className="h-7 bg-emerald-600 px-2.5 hover:bg-emerald-700"
                onClick={() => approveAction.mutate(approval.id)}
                disabled={approveAction.isPending}
              >
                <Check className="mr-1 h-3 w-3" />
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-red-300 px-2.5 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950"
                onClick={() => handleDeny(approval.id, approval.task_description)}
                disabled={denyAction.isPending}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
