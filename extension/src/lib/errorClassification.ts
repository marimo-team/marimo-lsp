const SAFE_CLASS_NAME = /^[A-Za-z_$][\w$.-]{0,79}$/;
const EXCEPTION_CLASS = /^\s*((?:[A-Za-z_$][\w$]*\.)*)([A-Za-z_$][\w$]*):/m;
const EXCEPTION_SUFFIX = /(?:Error|Exception|Warning)$/;
const NON_SUFFIX_BUILTIN_EXCEPTIONS = new Set([
  "BaseException",
  "BaseExceptionGroup",
  "ExceptionGroup",
  "GeneratorExit",
  "KeyboardInterrupt",
  "StopAsyncIteration",
  "StopIteration",
  "SystemExit",
]);

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
  const candidate = likelyExceptionClass(text);
  return candidate && SAFE_CLASS_NAME.test(candidate) ? candidate : undefined;
}

/** Whether text starts a Python-style exception line, without telemetry bounds. */
export function hasExceptionClassPrefix(text: string): boolean {
  return likelyExceptionClass(text) !== undefined;
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

function likelyExceptionClass(text: string): string | undefined {
  const match = text.match(EXCEPTION_CLASS);
  if (!match) return undefined;

  const [, qualifier, className] = match;
  const isRecognizable =
    Boolean(qualifier) ||
    EXCEPTION_SUFFIX.test(className) ||
    NON_SUFFIX_BUILTIN_EXCEPTIONS.has(className);
  return isRecognizable ? className : undefined;
}
