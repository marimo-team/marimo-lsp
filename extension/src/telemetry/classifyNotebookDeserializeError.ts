import { Cause, Redacted } from "effect";

import {
  MarimoClientStartError,
  MarimoCommandError,
} from "../lsp/MarimoClient.ts";
import { NotebookSourceError } from "../notebook/NotebookSourceError.ts";

export type NotebookDeserializeErrorKind =
  | "source.invalid-syntax"
  | "source.convertible"
  | "transport.lsp-start"
  | "transport.client-not-running"
  | "transport.timeout"
  | "rpc.internal";

export interface ErrorClassification {
  readonly report: boolean;
  readonly domain: "notebook.deserialize";
  readonly kind: NotebookDeserializeErrorKind;
  readonly safeContext: Readonly<Record<string, string | number>>;
}

export function classifyNotebookDeserializeError(
  error: unknown,
): ErrorClassification {
  if (error instanceof NotebookSourceError) {
    const kind = `source.${error.failure.kind}` as const;
    return {
      report: false,
      domain: "notebook.deserialize",
      kind,
      safeContext: {},
    };
  }

  if (error instanceof MarimoClientStartError) {
    return {
      report: true,
      domain: "notebook.deserialize",
      kind: "transport.lsp-start",
      safeContext: { "error.exception_class": error._tag },
    };
  }

  if (Cause.isTimeoutException(error)) {
    return {
      report: true,
      domain: "notebook.deserialize",
      kind: "transport.timeout",
      safeContext: { "error.exception_class": "TimeoutException" },
    };
  }

  if (error instanceof MarimoCommandError) {
    const method = commandMethod(error);
    const code = rpcCode(error.cause);
    const exceptionClass = safeClassName(error.cause);
    const kind = isClientNotRunning(error.cause)
      ? "transport.client-not-running"
      : "rpc.internal";
    return {
      report: true,
      domain: "notebook.deserialize",
      kind,
      safeContext: {
        ...(method ? { "rpc.method": method } : {}),
        ...(code === undefined ? {} : { "rpc.code": code }),
        "error.exception_class": exceptionClass,
      },
    };
  }

  const exceptionClass = safeClassName(error);
  return {
    report: true,
    domain: "notebook.deserialize",
    kind: "rpc.internal",
    safeContext: { "error.exception_class": exceptionClass },
  };
}

function commandMethod(error: MarimoCommandError): string | undefined {
  const command = Redacted.value(error.command);
  return command.params.method;
}

function rpcCode(error: unknown): number | undefined {
  return isRecord(error) && typeof error.code === "number"
    ? error.code
    : undefined;
}

function isClientNotRunning(error: unknown): boolean {
  return (
    isRecord(error) &&
    typeof error.message === "string" &&
    error.message.toLowerCase().includes("client is not running")
  );
}

function safeClassName(value: unknown): string {
  if (!isRecord(value)) return typeof value;
  for (const candidate of [value._tag, value.name, value.constructor?.name]) {
    if (
      typeof candidate === "string" &&
      /^[A-Za-z_$][\w$.-]{0,79}$/.test(candidate)
    ) {
      return candidate;
    }
  }
  return "Error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
