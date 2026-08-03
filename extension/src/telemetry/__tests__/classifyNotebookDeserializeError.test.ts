import { expect, it } from "@effect/vitest";
import { Cause, Redacted } from "effect";

import {
  MarimoClientStartError,
  MarimoCommandError,
} from "../../lsp/MarimoClient.ts";
import { NotebookSourceError } from "../../notebook/NotebookSourceError.ts";
import { classifyNotebookDeserializeError } from "../classifyNotebookDeserializeError.ts";

it("does not report known notebook source failures", () => {
  const syntax = classifyNotebookDeserializeError(
    new NotebookSourceError({
      failure: {
        kind: "invalid-syntax",
        line: 7,
        column: 3,
      },
    }),
  );
  const convertible = classifyNotebookDeserializeError(
    new NotebookSourceError({
      failure: {
        kind: "convertible",
      },
    }),
  );

  expect(syntax).toMatchObject({
    report: false,
    domain: "notebook.deserialize",
    kind: "source.invalid-syntax",
    safeContext: {},
  });
  expect(convertible).toMatchObject({
    report: false,
    kind: "source.convertible",
    safeContext: {},
  });
});

it("separates LSP startup failures", () => {
  const result = classifyNotebookDeserializeError(
    new MarimoClientStartError({
      exec: { command: "uv", args: ["run", "marimo-lsp"] },
      cause: new Error("spawn failed"),
    }),
  );

  expect(result).toEqual({
    report: true,
    domain: "notebook.deserialize",
    kind: "transport.lsp-start",
    safeContext: { "error.exception_class": "MarimoClientStartError" },
  });
});

it("separates deserialize timeouts from internal RPC failures", () => {
  const result = classifyNotebookDeserializeError(new Cause.TimeoutException());

  expect(result).toEqual({
    report: true,
    domain: "notebook.deserialize",
    kind: "transport.timeout",
    safeContext: { "error.exception_class": "TimeoutException" },
  });
});

it("groups internal RPC failures by method, code, and exception class", () => {
  const secret = "DO_NOT_UPLOAD_CLASSIFIER_SOURCE";
  const result = classifyNotebookDeserializeError(
    commandError({
      name: "ResponseError",
      code: -32603,
      message: secret,
    }),
  );

  expect(result).toEqual({
    report: true,
    domain: "notebook.deserialize",
    kind: "rpc.internal",
    safeContext: {
      "rpc.method": "deserialize",
      "rpc.code": -32603,
      "error.exception_class": "ResponseError",
    },
  });
  expect(JSON.stringify(result)).not.toContain(secret);
});

it("separates client lifecycle failures from internal RPC errors", () => {
  const result = classifyNotebookDeserializeError(
    commandError({
      name: "Error",
      message: "Client is not running",
    }),
  );

  expect(result.kind).toBe("transport.client-not-running");
  expect(result.safeContext).toEqual({
    "rpc.method": "deserialize",
    "error.exception_class": "Error",
  });
});

function commandError(cause: unknown) {
  return new MarimoCommandError({
    command: Redacted.make({
      command: "marimo.api" as const,
      params: {
        method: "deserialize" as const,
        params: { source: "DO_NOT_UPLOAD_COMMAND_SOURCE" },
      },
    }),
    cause,
  });
}
