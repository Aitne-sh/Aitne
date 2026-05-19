"use client";

interface SparklineProps {
  values: Array<number | null>;
  color: string;
  width?: number;
  height?: number;
  ariaLabel?: string;
}

interface Point {
  x: number;
  y: number;
}

export function Sparkline({
  values,
  color,
  width = 80,
  height = 24,
  ariaLabel,
}: SparklineProps) {
  // Need at least 2 positions to show a trend; a single bucket (Today view)
  // has no trend to draw, so bail rather than render a clipped half-circle
  // at x=0.
  if (values.length < 2) return null;
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;

  const max = Math.max(...present, 1);
  const step = width / (values.length - 1);

  // Split into consecutive non-null segments so gaps read as "no data",
  // not "zero". Isolated 1-point segments render as dots.
  const segments: Point[][] = [[]];
  values.forEach((v, i) => {
    if (v === null) {
      if (segments[segments.length - 1].length > 0) segments.push([]);
      return;
    }
    segments[segments.length - 1].push({
      x: i * step,
      y: height - (v / max) * (height - 4) - 2,
    });
  });

  return (
    <svg
      width={width}
      height={height}
      className="mt-2"
      role="img"
      aria-label={ariaLabel ?? "sparkline"}
    >
      {segments
        .filter((s) => s.length >= 2)
        .map((s, idx) => (
          <polyline
            key={`l${idx}`}
            points={s.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      {segments
        .filter((s) => s.length === 1)
        .map((s, idx) => (
          <circle key={`d${idx}`} cx={s[0].x} cy={s[0].y} r="1.5" fill={color} />
        ))}
    </svg>
  );
}
