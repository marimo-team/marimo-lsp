const SAFE_CLASS_NAME = /^[A-Za-z_$][\w$.-]{0,79}$/;
const EXCEPTION_CLASS =
  /^\s*(?:[A-Za-z_$][\w$]*\.)*((?!Traceback\b)[A-Za-z_$][\w$]*):/m;

export function safeErrorClassName(value: unknown): string {
  if (!isRecord(value)) return typeof value;
  let fallback: string | undefined;
  for (const candidate of [value._tag, value.name, value.constructor?.name]) {
    if (typeof candidate === "string" && SAFE_CLASS_NAME.test(candidate)) {
      if (candidate === "Error" && value instanceof Error) {
        fallback ??= candidate;
      } else {
        return candidate;
      }
    }
  }
  return fallback ?? "Error";
}

export function exceptionClassFromMessage(text: string): string | undefined {
  const match = text.match(EXCEPTION_CLASS);
  return match && SAFE_CLASS_NAME.test(match[1]) ? match[1] : undefined;
}

/** Whether text starts a Python-style exception line, without telemetry bounds. */
export function hasExceptionClassPrefix(text: string): boolean {
  return EXCEPTION_CLASS.test(text);
}

export function nestedErrorClassName(error: Error): string {
  const direct = safeErrorClassName(error);
  return direct === "Error"
    ? (exceptionClassFromMessage(error.message) ?? "Error")
    : direct;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
