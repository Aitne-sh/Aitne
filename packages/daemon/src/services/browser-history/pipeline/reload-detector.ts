const PAGE_TRANSITION_CORE_MASK = 0xff;
const PAGE_TRANSITION_RELOAD = 8;

export function isReloadTransition(transition: number | null | undefined): boolean {
  if (transition === null || transition === undefined) return false;
  return (transition & PAGE_TRANSITION_CORE_MASK) === PAGE_TRANSITION_RELOAD;
}

export interface ReloadPatternInput {
  host: string;
  path: string;
}

export function reloadPatternKey(input: ReloadPatternInput): string {
  const segments = (input.path || "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  const firstSegment = segments[0] ?? "";
  return firstSegment
    ? `${input.host}/${firstSegment.toLowerCase()}`
    : input.host;
}
