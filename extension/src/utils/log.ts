import { Effect } from "effect";

export const Log = {
  info: (message: string, annotations?: Record<string, unknown>) =>
    Effect.logInfo(message).pipe(Effect.annotateLogs(annotations ?? {})),
  trace: (message: string, annotations?: Record<string, unknown>) =>
    Effect.logTrace(message).pipe(Effect.annotateLogs(annotations ?? {})),
  debug: (message: string, annotations?: Record<string, unknown>) =>
    Effect.logDebug(message).pipe(Effect.annotateLogs(annotations ?? {})),
  warn: (message: string, annotations?: Record<string, unknown>) =>
    Effect.logWarning(message).pipe(Effect.annotateLogs(annotations ?? {})),
  error: (message: string, annotations?: Record<string, unknown>) =>
    Effect.logError(message).pipe(Effect.annotateLogs(annotations ?? {})),
  fatal: (message: string, annotations?: Record<string, unknown>) =>
    Effect.logFatal(message).pipe(Effect.annotateLogs(annotations ?? {})),
};
