/**
 * Extract the last Python exception line from an LSP ExecuteCommandError cause.
 *
 * The cause is typically a ResponseError from vscode-languageclient with:
 * - `.message`: often generic ("An error has occurred")
 * - `.data.traceback`: Python traceback frames (just file/line info)
 * - `.cause`: may contain an Error with the full RuntimeError message
 */
export function extractPythonError(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object") return undefined;

  // Check Error.cause chain (may contain "RuntimeError: Kernel failed to start: ...")
  if (
    "cause" in cause &&
    (cause as { cause: unknown }).cause instanceof Error
  ) {
    const detail = extractLastException(
      ((cause as { cause: unknown }).cause as Error).message,
    );
    if (detail) return detail;
  }

  // Check .message directly (if not the generic pygls message)
  if (cause instanceof Error && cause.message) {
    if (cause.message !== "An error has occurred") {
      const detail = extractLastException(cause.message);
      if (detail) return detail;
      return truncate(cause.message, 500);
    }
  }

  return undefined;
}

/** Find the last Python exception line (e.g. "ImportError: ...") in a traceback string. */
function extractLastException(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line && /^\w+(\.\w+)*(Error|Exception):/.test(line)) {
      return truncate(line, 500);
    }
  }
  return undefined;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}
