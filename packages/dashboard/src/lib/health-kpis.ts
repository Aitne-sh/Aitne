import type { MetricsDailyBucket, MetricsResponse } from "./api-types";
import { formatDuration } from "./utils";

export type KpiLevel = "good" | "warn" | "crit" | "neutral";

export interface HealthKpiCard {
  title: string;
  value: string;
  subtitle: string;
  level: KpiLevel;
  sparkline: Array<number | null> | null;
}

export function computeHealthKpis(
  daily: MetricsDailyBucket[],
  days: number,
  snapshot: MetricsResponse | undefined,
): HealthKpiCard[] {
  // days === 0 is the "Today" (agent-day) bucket. The normal `${days}d`
  // interpolation becomes "0d" which reads as broken English.
  const periodLabel = days === 0 ? "today" : `${days}d`;
  const periodPhrase = days === 0 ? "today" : `${days}-day`;

  const totalExec = daily.reduce((s, d) => s + d.executions, 0);
  const totalFail = daily.reduce((s, d) => s + d.failures, 0);
  const successRate = totalExec > 0 ? (totalExec - totalFail) / totalExec : null;
  const successLevel: KpiLevel =
    successRate === null
      ? "neutral"
      : successRate >= 0.95
        ? "good"
        : successRate >= 0.8
          ? "warn"
          : "crit";
  const dailySuccessRates: Array<number | null> = daily.map((d) =>
    d.executions > 0 ? (d.executions - d.failures) / d.executions : null,
  );

  const errorsLevel: KpiLevel =
    totalFail === 0 ? "good" : totalFail <= 5 ? "warn" : "crit";
  const dailyFailures: Array<number | null> = daily.map((d) =>
    d.executions > 0 ? d.failures : null,
  );

  const p50 = snapshot?.responseTime.p50 ?? null;
  const p95 = snapshot?.responseTime.p95 ?? null;
  const responseValue =
    p50 !== null && p95 !== null
      ? `${formatDuration(p50)} / ${formatDuration(p95)}`
      : "—";

  const reactionRate = snapshot?.notificationConfirmRate ?? null;
  const reactionValue =
    reactionRate !== null ? `${Math.round(reactionRate * 100)}%` : "—";
  const reactionDelivered = snapshot?.notificationCounts.delivered ?? 0;
  const reactionReacted = snapshot?.notificationCounts.reacted ?? 0;
  const dailyReactionRates: Array<number | null> = daily.map((d) =>
    d.notificationsDelivered > 0
      ? d.notificationsReacted / d.notificationsDelivered
      : null,
  );

  return [
    {
      title: "Success Rate",
      value:
        successRate !== null ? `${(successRate * 100).toFixed(1)}%` : "—",
      subtitle:
        successRate !== null
          ? `${totalExec - totalFail} / ${totalExec} ok`
          : "no data",
      level: successLevel,
      sparkline: dailySuccessRates,
    },
    {
      title: `Errors (${periodLabel})`,
      value: String(totalFail),
      subtitle:
        totalFail === 0
          ? "no failures"
          : days === 0
            ? "today total"
            : `${periodPhrase} total`,
      level: errorsLevel,
      sparkline: dailyFailures,
    },
    {
      title: "Response P50 / P95",
      value: responseValue,
      subtitle: "rolling 30d",
      level: "neutral",
      sparkline: null,
    },
    {
      title: "Reaction Rate",
      value: reactionValue,
      // When snapshot hasn't loaded yet, don't fake "0 of 0" — that reads as
      // real zero data. Fall back to the period label instead.
      subtitle:
        snapshot !== undefined
          ? `${reactionReacted} of ${reactionDelivered} in 30d`
          : "rolling 30d",
      level: "neutral",
      sparkline: dailyReactionRates,
    },
  ];
}
