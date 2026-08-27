import { expect, it } from "@effect/vitest";
import { Redacted } from "effect";

import { MarimoCommandError } from "../../lsp/MarimoClient.ts";
import { classifyNotebookDeserializeError } from "../classifyNotebookDeserializeError.ts";
import { classifySentryError } from "../sentrySink.ts";

function commandError(cause: Error): MarimoCommandError {
  return new MarimoCommandError({
    command: Redacted.make({
      kind: "deserialize",
      source: "",
    }),
    cause,
    mode: "wasm",
  });
}

function rpcCommandError(rootCause: Error): MarimoCommandError {
  return commandError(
    Object.assign(new Error("An error has occurred", { cause: rootCause }), {
      name: "ResponseError",
      code: -32603,
    }),
  );
}

function deserializeErrorData(error: MarimoCommandError) {
  const classification = classifyNotebookDeserializeError(error);
  return {
    "error.domain": classification.domain,
    "error.kind": classification.kind,
    ...classification.safeContext,
  };
}

it("fingerprints command errors by their nested Python failure", () => {
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

  expect(kernelExit).toEqual({
    tags: {
      "error.domain": "notebook.deserialize",
      "error.exception_class": "KernelOpenError",
      "error.kind": "marimo-command.kernel-bridge-exit",
      "rpc.method": "deserialize",
      "rpc.code": "-32603",
      "lsp.mode": "wasm",
    },
    fingerprint: ["marimo command error", "kernel-bridge-exit"],
  });
  expect(duplicateCell.fingerprint).toEqual([
    "marimo command error",
    "duplicate-cell-id",
  ]);
  expect(duplicateStableId.fingerprint).toEqual(duplicateCell.fingerprint);
  expect(duplicateStableId.tags["error.exception_class"]).toBe(
    "DuplicateCellIdError",
  );
  expect(kernelExit.fingerprint).not.toEqual(duplicateCell.fingerprint);
});

it("preserves specific transport classifications for command failures", () => {
  const error = commandError(new Error("Client is not running"));

  expect(classifySentryError(error, deserializeErrorData(error))).toEqual({
    tags: {
      "error.domain": "notebook.deserialize",
      "error.exception_class": "Error",
      "error.kind": "transport.client-not-running",
      "rpc.method": "deserialize",
      "lsp.mode": "wasm",
    },
    fingerprint: [
      "notebook.deserialize",
      "transport.client-not-running",
      "Error",
    ],
  });
});
