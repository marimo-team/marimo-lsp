import * as Vitest from "@effect/vitest";
import { Cause, Redacted } from "effect";

import * as MarimoClient from "../../src/lsp/MarimoClient.ts";
import { NotebookSourceError } from "../../src/notebook/NotebookSourceError.ts";
import { classifyNotebookDeserializeError } from "../../src/telemetry/classifyNotebookDeserializeError.ts";

Vitest.it("does not report known notebook source failures", () => {
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

  Vitest.expect(syntax).toMatchObject({
    report: false,
    domain: "notebook.deserialize",
    kind: "source.invalid-syntax",
    safeContext: {},
  });
  Vitest.expect(convertible).toMatchObject({
    report: false,
    kind: "source.convertible",
    safeContext: {},
  });
});

Vitest.it("separates LSP startup failures", () => {
  const result = classifyNotebookDeserializeError(
    new MarimoClient.StartError({
      exec: { command: "uv", args: ["run", "marimo-lsp"] },
      mode: "uv",
      cause: new Error("spawn failed"),
    }),
  );

  Vitest.expect(result).toEqual({
    report: true,
    domain: "notebook.deserialize",
    kind: "transport.lsp-start",
    safeContext: {
      "error.exception_class": "MarimoClient.StartError",
      "lsp.mode": "uv",
    },
  });
});

Vitest.it("separates deserialize timeouts from internal RPC failures", () => {
  const result = classifyNotebookDeserializeError(new Cause.TimeoutError());

  Vitest.expect(result).toEqual({
    report: true,
    domain: "notebook.deserialize",
    kind: "transport.timeout",
    safeContext: { "error.exception_class": "TimeoutError" },
  });
});

Vitest.it(
  "groups internal RPC failures by method, code, and exception class",
  () => {
    const secret = "DO_NOT_UPLOAD_CLASSIFIER_SOURCE";
    const result = classifyNotebookDeserializeError(
      commandError({
        name: "ResponseError",
        code: -32603,
        message: secret,
      }),
    );

    Vitest.expect(result).toEqual({
      report: true,
      domain: "notebook.deserialize",
      kind: "rpc.internal",
      safeContext: {
        "rpc.method": "parse-notebook",
        "rpc.code": -32603,
        "error.exception_class": "ResponseError",
        "lsp.mode": "wasm",
      },
    });
    Vitest.expect(JSON.stringify(result)).not.toContain(secret);
  },
);

Vitest.it(
  "separates client lifecycle failures from internal RPC errors",
  () => {
    const result = classifyNotebookDeserializeError(
      commandError({
        name: "Error",
        message: "Client is not running",
      }),
    );

    Vitest.expect(result.kind).toBe("transport.client-not-running");
    Vitest.expect(result.safeContext).toEqual({
      "rpc.method": "parse-notebook",
      "error.exception_class": "Error",
      "lsp.mode": "wasm",
    });
  },
);

function commandError(cause: unknown) {
  return new MarimoClient.CommandError({
    command: Redacted.make({
      kind: "parse-notebook" as const,
      source: "DO_NOT_UPLOAD_COMMAND_SOURCE",
    }),
    cause,
    mode: "wasm",
  });
}
