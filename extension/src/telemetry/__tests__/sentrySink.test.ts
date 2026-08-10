import { expect, it } from "@effect/vitest";
import { Redacted } from "effect";

import { MarimoCommandError } from "../../lsp/MarimoClient.ts";
import { classifySentryError } from "../sentrySink.ts";

function marimoCommandError(rootCause: Error): MarimoCommandError {
  return new MarimoCommandError({
    command: Redacted.make({
      command: "marimo.api",
      params: {
        method: "deserialize",
        params: { source: "" },
      },
    }),
    cause: new Error("An error has occurred", { cause: rootCause }),
    mode: "wasm",
  });
}

it("fingerprints command errors by their nested Python failure", () => {
  const kernelExit = classifySentryError(
    marimoCommandError(
      new Error(
        "marimo_lsp.kernels.KernelOpenError: Kernel bridge exited unexpectedly (code=1, signal=jsnull)",
      ),
    ),
    undefined,
  );
  const duplicateCell = classifySentryError(
    marimoCommandError(new Error("ValueError: Cell 'xXTn' already exists")),
    undefined,
  );
  const duplicateStableId = classifySentryError(
    marimoCommandError(
      new Error(
        "marimo_lsp.app_file_manager.DuplicateCellIdError: Notebook contains duplicate stable cell IDs: DnEU",
      ),
    ),
    undefined,
  );

  expect(kernelExit).toEqual({
    tags: {
      "error.exception_class": "KernelOpenError",
      "error.kind": "marimo-command.kernel-bridge-exit",
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
