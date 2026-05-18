export interface ParsedTraceback {
  name: string;
  message: string;
  stack: string;
}

export type CellIdToIndex = (cellId: string) => number | undefined;

const HTML_ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
  "&amp;": "&",
};

function decodeEntities(s: string): string {
  return s.replace(
    /&(?:quot|apos|#39|lt|gt|nbsp|amp);/g,
    (m) => HTML_ENTITIES[m] ?? m,
  );
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ESC = "";
const ANSI = {
  reset: `${ESC}[0m`,
  boldRed: `${ESC}[1;31m`,
  cyan: `${ESC}[36m`,
  dim: `${ESC}[2m`,
} as const;

// linecache-backed temp file path: extract the marimo cell_id encoded in it.
function extractCellId(path: string): string | undefined {
  return /__marimo__cell_([^/\\]+)_\.py$/.exec(path)?.[1];
}

const FRAME_RE = /^(\s*)File\s+"([^"]+)",\s+line\s+(\d+)(.*)$/;

function rewriteFrame(line: string, cellIdToIndex?: CellIdToIndex): string {
  return line.replace(FRAME_RE, (_full, indent, path, lineNo, tail) => {
    const cellId = extractCellId(path);
    if (cellId !== undefined) {
      const idx = cellIdToIndex?.(cellId);
      const label = idx !== undefined ? `cell-${idx + 1}` : "cell-?";
      return `${indent}Cell ${ANSI.cyan}${label}${ANSI.reset}${ANSI.dim}, line ${lineNo}${ANSI.reset}`;
    }
    // Keep ANSI strictly OUTSIDE the anchor — ANSI codes inside the anchor
    // text get split into separate segments by the ANSI parser before the
    // HTML-link regex runs, breaking link detection.
    const href = `${escapeHtml(path)}:${lineNo}`;
    const label = `${path}:${lineNo}`;
    return `${indent}File <a href="${href}">${label}</a>${ANSI.dim}${tail}${ANSI.reset}`;
  });
}

const EXCEPTION_LINE_RE = /^([A-Za-z_][\w.]*)(:.*)?$/;

function colorExceptionLine(line: string): string {
  return line.replace(EXCEPTION_LINE_RE, `${ANSI.boldRed}$1${ANSI.reset}$2`);
}

function findExceptionLineIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || /^\s/.test(line) || line.startsWith("Traceback ")) continue;
    if (
      line.startsWith("The above exception") ||
      line.startsWith("During handling")
    ) {
      continue;
    }
    return i;
  }
  return -1;
}

function parseNameAndMessage(line: string): { name: string; message: string } {
  const colon = line.indexOf(":");
  if (colon === -1) return { name: line.trim(), message: "" };
  return {
    name: line.slice(0, colon).trim(),
    message: line.slice(colon + 1).trim(),
  };
}

export function parseTraceback(
  pygmentsHtml: string,
  cellIdToIndex?: CellIdToIndex,
): ParsedTraceback {
  const raw = decodeEntities(stripTags(pygmentsHtml));
  const lines = raw.split("\n").map((l) => rewriteFrame(l, cellIdToIndex));
  const exceptionIdx = findExceptionLineIndex(lines);
  let name = "";
  let message = "";
  if (exceptionIdx !== -1) {
    ({ name, message } = parseNameAndMessage(lines[exceptionIdx]));
    lines[exceptionIdx] = colorExceptionLine(lines[exceptionIdx]);
  }
  const stack = lines.join("\n").replace(/\n+$/, "");
  return { name, message, stack };
}
