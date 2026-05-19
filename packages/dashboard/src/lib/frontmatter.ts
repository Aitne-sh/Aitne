export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | FrontmatterValue[];

export interface ParsedFrontmatter {
  fields: Array<{ key: string; value: FrontmatterValue }>;
  body: string;
}

const OPEN_RE = /^---\n/;

export function extractFrontmatter(content: string): ParsedFrontmatter | null {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!OPEN_RE.test(normalized)) return null;
  const afterOpen = 4;
  const endIdx = normalized.indexOf("\n---", afterOpen - 1);
  if (endIdx < 0) return null;
  const block = normalized.slice(afterOpen, endIdx);

  let bodyStart = endIdx + "\n---".length;
  if (normalized[bodyStart] === "\n") bodyStart++;
  const body = normalized.slice(bodyStart);

  const fields = parseBlock(block);
  if (fields.length === 0) return null;
  return { fields, body };
}

function parseBlock(block: string): ParsedFrontmatter["fields"] {
  const lines = block.split("\n");
  const fields: ParsedFrontmatter["fields"] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1];
    const rawInline = match[2];

    if (rawInline.length > 0) {
      fields.push({ key, value: parseScalarOrInline(rawInline) });
      i++;
      continue;
    }

    // Block form — collect indented `- item` lines below.
    const items: FrontmatterValue[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (!next.trim()) {
        j++;
        continue;
      }
      const itemMatch = /^\s*-\s+(.*)$/.exec(next);
      if (!itemMatch) break;
      items.push(parseScalarOrInline(itemMatch[1]));
      j++;
    }
    fields.push({ key, value: items.length > 0 ? items : null });
    i = j;
  }

  return fields;
}

function parseScalarOrInline(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (value.length === 0) return "";

  // Inline array [a, b, "c"]
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitInlineArray(inner).map(parseScalarOrInline);
  }

  // Quoted string
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;

  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);

  return value;
}

function splitInlineArray(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote && inner[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type FieldKind =
  | "date"
  | "datetime"
  | "boolean"
  | "number"
  | "list"
  | "empty"
  | "text";

export function inferKind(value: FrontmatterValue): FieldKind {
  if (Array.isArray(value)) return "list";
  if (value === null) return "empty";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") {
    if (value.length === 0) return "empty";
    if (ISO_DATETIME_RE.test(value)) return "datetime";
    if (ISO_DATE_RE.test(value)) return "date";
    return "text";
  }
  return "text";
}
