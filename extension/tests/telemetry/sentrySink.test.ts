import * as Vitest from "@effect/vitest";
import { Redacted } from "effect";

import * as MarimoClient from "../../src/lsp/MarimoClient.ts";
import { classifyNotebookDeserializeError } from "../../src/telemetry/classifyNotebookDeserializeError.ts";
import { classifySentryError } from "../../src/telemetry/sentrySink.ts";

function commandError(cause: Error): MarimoClient.CommandError {
  return new MarimoClient.CommandError({
    command: Redacted.make({
      kind: "parse-notebook",
      source: "",
    }),
    cause,
    mode: "wasm",
  });
}

function rpcCommandError(rootCause: Error): MarimoClient.CommandError {
  return commandError(
    Object.assign(new Error("An error has occurred", { cause: rootCause }), {
      name: "ResponseError",
      code: -32603,
    }),
  );
}

function deserializeErrorData(error: MarimoClient.CommandError) {
  const classification = classifyNotebookDeserializeError(error);
  return {
    "error.domain": classification.domain,
    "error.kind": classification.kind,
    ...classification.safeContext,
  };
}

Vitest.it("fingerprints command errors by their nested Python failure", () => {
  const kernelError = rpcCommandError(
    new Error(
      "marimo_lsp.kernels.KernelOpenError: Kernel bridge exited unexpectedly (code=1, signal=jsnull)",
    ),
  );
  const kernelExit = classifySentryError(
    kernelError,
    deserializeErrorData(kernelError),
  );
  const duplicateError = rpcCommandError(
    new Error("ValueError: Cell 'xXTn' already exists"),
  );
  const duplicateCell = classifySentryError(
    duplicateError,
    deserializeErrorData(duplicateError),
  );
  const duplicateStableIdError = rpcCommandError(
    new Error(
      "marimo_lsp.app_file_manager.DuplicateCellIdError: Notebook contains duplicate stable cell IDs: DnEU",
    ),
  );
  const duplicateStableId = classifySentryError(
    duplicateStableIdError,
    deserializeErrorData(duplicateStableIdError),
  );

  Vitest.expect(kernelExit).toEqual({
    tags: {
      "error.domain": "notebook.deserialize",
      "error.exception_class": "KernelOpenError",
      "error.kind": "marimo-command.kernel-bridge-exit",
      "rpc.method": "parse-notebook",
      "rpc.code": "-32603",
      "lsp.mode": "wasm",
    },
    fingerprint: ["marimo command error", "kernel-bridge-exit"],
  });
  Vitest.expect(duplicateCell.fingerprint).toEqual([
    "marimo command error",
    "duplicate-cell-id",
  ]);
  Vitest.expect(duplicateStableId.fingerprint).toEqual(
    duplicateCell.fingerprint,
  );
  Vitest.expect(duplicateStableId.tags["error.exception_class"]).toBe(
    "DuplicateCellIdError",
  );
  Vitest.expect(kernelExit.fingerprint).not.toEqual(duplicateCell.fingerprint);
});

Vitest.it(
  "preserves specific transport classifications for command failures",
  () => {
    const error = commandError(new Error("Client is not running"));

    Vitest.expect(
      classifySentryError(error, deserializeErrorData(error)),
    ).toEqual({
      tags: {
        "error.domain": "notebook.deserialize",
        "error.exception_class": "Error",
        "error.kind": "transport.client-not-running",
        "rpc.method": "parse-notebook",
        "lsp.mode": "wasm",
      },
      fingerprint: [
        "notebook.deserialize",
        "transport.client-not-running",
        "Error",
      ],
    });
  },
);
