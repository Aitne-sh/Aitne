"use client";

import { useRef, useState } from "react";

// ── Geometry helpers ──

const CX = 120;
const CY = 120;
const SIZE = 240;

/** Convert an hour (0–24, fractional) to an angle in radians (0:00 = top, CW). */
export function hourToAngle(hour: number): number {
  return ((hour % 24) / 24) * Math.PI * 2 - Math.PI / 2;
}

/** Convert a radians angle back to an hour (0–24). */
export function angleToHour(angle: number): number {
  let h = ((angle + Math.PI / 2) / (Math.PI * 2)) * 24;
  if (h < 0) h += 24;
  return h % 24;
}

/** Point on the circle at the given angle and radius. */
function polarPoint(angle: number, r: number): { x: number; y: number } {
  return { x: CX + r * Math.cos(angle), y: CY + r * Math.sin(angle) };
}

/** SVG arc path from startAngle to endAngle at radius r (always clockwise). */
export function arcPath(startAngle: number, endAngle: number, r: number): string {
  let sweep = endAngle - startAngle;
  if (sweep <= 0) sweep += Math.PI * 2;
  if (sweep > Math.PI * 2 - 0.001) sweep = Math.PI * 2 - 0.001;
  const largeArc = sweep > Math.PI ? 1 : 0;
  const s = polarPoint(startAngle, r);
  const e = polarPoint(startAngle + sweep, r);
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e.x} ${e.y}`;
}

// ── Parse/format helpers ──

/** Parse "HH:MM" → fractional hours (e.g. "23:30" → 23.5). */
export function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) + (m ?? 0) / 60;
}

/** Format fractional hours → "HH:MM". */
export function formatHHMM(h: number): string {
  const hh = Math.floor(((h % 24) + 24) % 24);
  const mm = Math.round((h - Math.floor(h)) * 60) % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Snap fractional hours to the nearest 15 minutes. */
export function snap15(h: number): number {
  return Math.round(h * 4) / 4;
}

/** Snap fractional hours to the nearest whole hour. */
export function snapHour(h: number): number {
  return Math.round(h) % 24;
}

// ── Types ──

export interface TimeRangeRingValues {
  quietHoursStart: string;   // "HH:MM"
  quietHoursEnd: string;     // "HH:MM"
  activeStartHour: number;   // 0–23
  activeEndHour: number;     // 1–24
  dayBoundaryHour: number;   // 0–9
}

type DragTarget =
  | "quietStart"
  | "quietEnd"
  | "activeStart"
  | "activeEnd"
  | null;

// ── Theme-aware colors (CSS variables) ──

const COLOR_QUIET = "var(--color-destructive)";
const COLOR_ACTIVE = "var(--color-success)";
const COLOR_DAY_BOUNDARY = "var(--color-primary)";

// ── Component ──

export function TimeRangeRing({
  values,
  onChange,
}: {
  values: TimeRangeRingValues;
  onChange: (next: TimeRangeRingValues) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<DragTarget>(null);
  const [hovered, setHovered] = useState<DragTarget>(null);

  const quietStartH = parseHHMM(values.quietHoursStart);
  const quietEndH = parseHHMM(values.quietHoursEnd);
  const activeStartH = values.activeStartHour;
  const activeEndH = values.activeEndHour % 24;

  const quietStartA = hourToAngle(quietStartH);
  const quietEndA = hourToAngle(quietEndH);
  const activeStartA = hourToAngle(activeStartH);
  const activeEndA = hourToAngle(activeEndH);
  const dayBoundaryA = hourToAngle(values.dayBoundaryHour);

  const QUIET_R = 90;
  const ACTIVE_R = 75;

  // Pointer event helpers — work with both mouse and touch.
  const getHourFromPointer = (e: React.PointerEvent | PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    const scaleX = SIZE / rect.width;
    const scaleY = SIZE / rect.height;
    const x = (e.clientX - rect.left) * scaleX - CX;
    const y = (e.clientY - rect.top) * scaleY - CY;
    return angleToHour(Math.atan2(y, x));
  };

  const handlePointerDown = (target: DragTarget) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragging(target);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const hour = getHourFromPointer(e);
    const next = { ...values };
    switch (dragging) {
      case "quietStart":
        next.quietHoursStart = formatHHMM(snap15(hour));
        break;
      case "quietEnd":
        next.quietHoursEnd = formatHHMM(snap15(hour));
        break;
      case "activeStart":
        next.activeStartHour = snapHour(hour);
        break;
      case "activeEnd": {
        const snapped = snapHour(hour);
        next.activeEndHour = snapped === 0 ? 24 : snapped;
        break;
      }
    }
    onChange(next);
  };

  const handlePointerUp = () => {
    setDragging(null);
  };

  const hourLabels = [0, 3, 6, 9, 12, 15, 18, 21];

  return (
    <div className="flex items-center justify-center">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full max-w-[280px] select-none touch-none"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {/* Background circle */}
        <circle
          cx={CX}
          cy={CY}
          r={100}
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          className="text-border"
        />

        {/* Hour tick marks */}
        {Array.from({ length: 24 }, (_, i) => {
          const a = hourToAngle(i);
          const isMajor = i % 3 === 0;
          const inner = polarPoint(a, isMajor ? 95 : 97);
          const outer = polarPoint(a, 100);
          return (
            <line
              key={i}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="currentColor"
              strokeWidth={isMajor ? 1.5 : 0.5}
              className="text-muted-foreground"
            />
          );
        })}

        {/* Hour labels */}
        {hourLabels.map((h) => {
          const a = hourToAngle(h);
          const p = polarPoint(a, 108);
          return (
            <text
              key={h}
              x={p.x}
              y={p.y}
              textAnchor="middle"
              dominantBaseline="central"
              className="fill-muted-foreground text-[9px]"
            >
              {h}
            </text>
          );
        })}

        {/* Quiet hours arc (destructive/red) */}
        <path
          d={arcPath(quietStartA, quietEndA, QUIET_R)}
          fill="none"
          stroke={COLOR_QUIET}
          strokeWidth={8}
          strokeLinecap="round"
          opacity={0.6}
        />

        {/* Active hours arc (success/green) */}
        <path
          d={arcPath(activeStartA, activeEndA, ACTIVE_R)}
          fill="none"
          stroke={COLOR_ACTIVE}
          strokeWidth={8}
          strokeLinecap="round"
          opacity={0.6}
        />

        {/* Day boundary marker (primary/blue dashed line) */}
        {(() => {
          const inner = polarPoint(dayBoundaryA, 60);
          const outer = polarPoint(dayBoundaryA, 100);
          return (
            <line
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke={COLOR_DAY_BOUNDARY}
              strokeWidth={2}
              strokeDasharray="4 2"
            />
          );
        })()}

        {/* Day boundary label */}
        {(() => {
          const p = polarPoint(dayBoundaryA, 53);
          return (
            <text
              x={p.x}
              y={p.y}
              textAnchor="middle"
              dominantBaseline="central"
              className="fill-primary text-[8px] font-medium"
            >
              day
            </text>
          );
        })()}

        {/* Drag handles — render active/dragging handle last for z-order */}
        {renderHandles({
          dragging,
          hovered,
          setDragging,
          setHovered,
          handlePointerDown,
          quietStartA,
          quietEndA,
          activeStartA,
          activeEndA,
          QUIET_R,
          ACTIVE_R,
          values,
        })}

        {/* Center legend */}
        <text
          x={CX}
          y={CX - 8}
          textAnchor="middle"
          className="fill-muted-foreground text-[8px]"
        >
          <tspan style={{ fill: COLOR_QUIET }}>&#9679;</tspan> quiet hours
        </text>
        <text
          x={CX}
          y={CX + 4}
          textAnchor="middle"
          className="fill-muted-foreground text-[8px]"
        >
          <tspan style={{ fill: COLOR_ACTIVE }}>&#9679;</tspan> active window
        </text>
        <text
          x={CX}
          y={CX + 16}
          textAnchor="middle"
          className="fill-muted-foreground text-[8px]"
        >
          <tspan style={{ fill: COLOR_DAY_BOUNDARY }}>---</tspan> day boundary
        </text>
      </svg>
    </div>
  );
}

/**
 * Renders all 4 drag handles, with the currently active (dragging or hovered)
 * handle rendered last so it appears on top in SVG z-order.
 */
function renderHandles({
  dragging,
  hovered,
  setHovered,
  handlePointerDown,
  quietStartA,
  quietEndA,
  activeStartA,
  activeEndA,
  QUIET_R,
  ACTIVE_R,
  values,
}: {
  dragging: DragTarget;
  hovered: DragTarget;
  setDragging: (t: DragTarget) => void;
  setHovered: (t: DragTarget) => void;
  handlePointerDown: (target: DragTarget) => (e: React.PointerEvent) => void;
  quietStartA: number;
  quietEndA: number;
  activeStartA: number;
  activeEndA: number;
  QUIET_R: number;
  ACTIVE_R: number;
  values: TimeRangeRingValues;
}) {
  const activeTarget = dragging ?? hovered;
  const handles: { target: DragTarget; angle: number; r: number; color: string; label: string }[] = [
    { target: "quietStart", angle: quietStartA, r: QUIET_R, color: COLOR_QUIET, label: values.quietHoursStart },
    { target: "quietEnd", angle: quietEndA, r: QUIET_R, color: COLOR_QUIET, label: values.quietHoursEnd },
    { target: "activeStart", angle: activeStartA, r: ACTIVE_R, color: COLOR_ACTIVE, label: `${values.activeStartHour}:00` },
    { target: "activeEnd", angle: activeEndA, r: ACTIVE_R, color: COLOR_ACTIVE, label: `${values.activeEndHour}:00` },
  ];

  // Sort so the active handle renders last (on top in SVG).
  const sorted = handles.sort((a, b) => {
    const aActive = a.target === activeTarget ? 1 : 0;
    const bActive = b.target === activeTarget ? 1 : 0;
    return aActive - bActive;
  });

  return (
    <>
      {sorted.map((h) => (
        <Handle
          key={h.target}
          angle={h.angle}
          r={h.r}
          color={h.color}
          label={h.label}
          active={h.target === activeTarget}
          onPointerDown={handlePointerDown(h.target)}
          onPointerEnter={() => setHovered(h.target)}
          onPointerLeave={() => setHovered(null)}
        />
      ))}
    </>
  );
}

/** Clamp label position within the viewBox so text isn't clipped. */
function clampLabelPos(x: number, y: number): { lx: number; ly: number } {
  const PAD = 12;
  return {
    lx: Math.max(PAD, Math.min(SIZE - PAD, x)),
    ly: Math.max(PAD, Math.min(SIZE - PAD, y - 12)),
  };
}

function Handle({
  angle,
  r,
  color,
  label,
  active,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
}: {
  angle: number;
  r: number;
  color: string;
  label: string;
  active: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const p = polarPoint(angle, r);
  const handleR = active ? 7 : 5;
  const { lx, ly } = clampLabelPos(p.x, p.y);
  return (
    <g
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="cursor-grab active:cursor-grabbing"
    >
      {/* Invisible larger hit area */}
      <circle cx={p.x} cy={p.y} r={12} fill="transparent" />
      {/* Visible handle */}
      <circle
        cx={p.x}
        cy={p.y}
        r={handleR}
        fill={color}
        stroke="var(--color-background)"
        strokeWidth={2}
      />
      {/* Label (only on hover / drag) */}
      {active && (
        <text
          x={lx}
          y={ly}
          textAnchor="middle"
          className="fill-foreground text-[9px] font-medium pointer-events-none"
        >
          {label}
        </text>
      )}
    </g>
  );
}
