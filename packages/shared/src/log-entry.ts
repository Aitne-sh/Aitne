/** A single application log entry surfaced to the dashboard. */
export interface LogEntry {
  id: number;
  timestamp: string;
  level: string;
  logger: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface SystemLogsResponse {
  logs: LogEntry[];
  loggers: string[];
}
