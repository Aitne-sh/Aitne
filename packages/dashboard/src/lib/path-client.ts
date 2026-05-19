export function isClientAbsolutePath(path: string): boolean {
  const trimmed = path.trim();
  return trimmed.startsWith("/")
    || trimmed.startsWith("~/")
    || trimmed.startsWith("~\\")
    || /^[A-Za-z]:[\\/]/.test(trimmed)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(trimmed)
    || /^\/\/[^/]+\/[^/]+/.test(trimmed);
}

export function hasPathTraversalSegment(path: string): boolean {
  return path.trim().split(/[\\/]+/).some((seg) => seg === "..");
}

function looksWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path)
    || /^\\\\/.test(path)
    || /^\/\/[^/]+\/[^/]+/.test(path)
    || path.includes("\\");
}

function normalizeForCompare(path: string, windows: boolean): string {
  let normalized = path.trim().replace(/[\\/]+$/g, "");
  if (windows) {
    normalized = normalized.replace(/[\\/]+/g, "/").toLowerCase();
  }
  return normalized;
}

export function isClientPathInsideOrEqual(parent: string, candidate: string): boolean {
  if (parent.trim().length === 0 || candidate.trim().length === 0) return false;
  const windows = looksWindowsPath(parent) || looksWindowsPath(candidate);
  const normalizedParent = normalizeForCompare(parent, windows);
  const normalizedCandidate = normalizeForCompare(candidate, windows);
  return normalizedCandidate === normalizedParent
    || normalizedCandidate.startsWith(`${normalizedParent}/`);
}
