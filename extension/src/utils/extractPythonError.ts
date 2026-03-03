import { Option } from "effect";

/**
 * Extract the last Python exception line from an LSP ExecuteCommandError cause.
 *
 * The cause is typically a ResponseError from vscode-languageclient with:
 * - `.message`: often generic ("An error has occurred")
 * - `.data.traceback`: Python traceback frames (just file/line info)
 * - `.cause`: may contain an Error with the full RuntimeError message
 */
export function extractPythonError(cause: unknown): Option.Option<string> {
  if (!cause || typeof cause !== "object") {
    return Option.none();
  }

  // Check Error.cause chain (may contain "RuntimeError: Kernel failed to start: ...")
  if (hasErrorCause(cause)) {
    return extractLastException(cause.cause.message);
  }

  // Check .message directly (if not the generic pygls message)
  if (cause instanceof Error && cause.message) {
    if (cause.message !== "An error has occurred") {
      const detail = extractLastException(cause.message);
      if (Option.isSome(detail)) {
        return detail;
      }
      return Option.some(truncate(cause.message, 500));
    }
  }

  return Option.none();
}

/**
 * Detect module-shadowing errors from Python's own error messages.
 * Python includes "(consider renaming '/path/to/file.py' ...)" when a local
 * file shadows a module. We extract and surface this as a user-friendly message.
 */
export function extractModuleShadowingError(
  cause: unknown,
): Option.Option<string> {
  return extractErrorText(cause).pipe(
    Option.flatMapNullable((text) =>
      /\(consider renaming '([^']+)'/i.exec(text),
    ),
    Option.map((match) => {
      const filePath = match[1];
      const fileName = filePath.split("/").pop() ?? filePath;
      return `A file in your project named '${fileName}' is shadowing a Python module. Consider renaming it.`;
    }),
  );
}

/** Walk the cause chain and return the first non-empty error message. */
function extractErrorText(cause: unknown): Option.Option<string> {
  if (cause && typeof cause === "object" && hasErrorCause(cause)) {
    return Option.some(cause.cause.message);
  }

  if (cause instanceof Error && cause.message) {
    return Option.some(cause.message);
  }

  return Option.none();
}

function hasErrorCause(value: object): value is { cause: Error } {
  return "cause" in value && value.cause instanceof Error;
}

/** Find the last Python exception line (e.g. "ImportError: ...") in a traceback string. */
function extractLastException(text: string): Option.Option<string> {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line && /^\w+(\.\w+)*(Error|Exception):/.test(line)) {
      return Option.some(truncate(line, 500));
    }
  }
  return Option.none();
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}
