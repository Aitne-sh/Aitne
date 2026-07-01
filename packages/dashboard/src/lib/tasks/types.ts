/**
 * Unified Task Board — dashboard-side DTO mirror of the daemon's
 * `GET /api/tasks` response (docs/design/appendices/unified-task-board.md §5.2a).
 * Kept in sync with `packages/daemon/src/core/task-board/types.ts`.
 */

export type TaskKind =
  | "dm"
  | "app_fetch"
  | "agent"
  | "trigger"
  | "reminder"
  | "background"
  | "browser";

export type TaskOrigin = "system" | "user" | "agent";

export interface TaskBoardItem {
  ref: string;
  title: string;
  kind: TaskKind;
  status: string;
  cadence: string | null;
  fulfilledBy: string;
  origin: TaskOrigin;
  lastResult: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface TasksListResponse {
  items: TaskBoardItem[];
  total: number;
  generatedAt: string;
}
