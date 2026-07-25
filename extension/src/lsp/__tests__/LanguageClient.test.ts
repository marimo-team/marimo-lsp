import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { findLspExecutable } from "../LanguageClient.ts";

describe("findLspExecutable", () => {
  it.scoped("uses a compatible Python range for the bundled LSP", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        NodeFs.mkdtempDisposableSync(
          NodePath.join(NodeOs.tmpdir(), "marimo-lsp-language-client-"),
        ),
      ),
      (directory) =>
        Effect.gen(function* () {
          const sdist = NodePath.join(directory.path, "marimo_lsp-0.1.0");
          NodeFs.mkdirSync(sdist);

          const executable = yield* findLspExecutable(
            "bundled-uv",
            directory.path,
          );

          expect(executable).toEqual({
            command: "bundled-uv",
            args: [
              "tool",
              "run",
              "--python",
              ">=3.13,<3.15",
              "--from",
              sdist,
              "marimo-lsp",
            ],
          });
        }),
      (directory) => Effect.sync(() => directory.remove()),
    ),
  );
});
