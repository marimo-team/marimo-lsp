import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  createNotebookCell,
  createTestNotebookDocument,
} from "../../__mocks__/TestVsCode.ts";
import { decodeCommandArguments } from "../../commands.ts";
import { restartKernelCommand } from "../restartKernel.ts";

describe("restartKernel command definition", () => {
  it.effect("decodes optional notebook toolbar context", () =>
    Effect.gen(function* () {
      const notebookUri = {
        scheme: "file",
        path: "/notebook.py",
        with() {
          return this;
        },
        toString() {
          return "file:///notebook.py";
        },
      };
      const context = {
        ui: true,
        notebookEditor: { notebookUri },
        source: "notebookToolbar",
      };
      const args = yield* decodeCommandArguments(restartKernelCommand, [
        context,
      ]);
      expect(args[0]).toBe(context);
    }),
  );

  it.effect("accepts no context", () =>
    Effect.gen(function* () {
      const args = yield* decodeCommandArguments(restartKernelCommand, []);
      expect(args).toEqual([]);
    }),
  );

  it.effect(
    "decodes a notebook toolbar hint whose editor URI was omitted",
    () =>
      Effect.gen(function* () {
        const context = {
          ui: true as const,
          source: "notebookToolbar" as const,
          notebookEditor: {},
        };

        const args = yield* decodeCommandArguments(restartKernelCommand, [
          context,
        ]);

        expect(args[0]).toBe(context);
      }),
  );

  it.effect("rejects unrelated UI metadata", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        decodeCommandArguments(restartKernelCommand, [
          { ui: true, source: "editorToolbar", notebookEditor: {} },
        ]),
      );

      expect(result._tag).toBe("Left");
    }),
  );

  it.effect("rejects a malformed notebook URI", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        decodeCommandArguments(restartKernelCommand, [
          {
            ui: true,
            source: "notebookToolbar",
            notebookEditor: { notebookUri: "not-a-vscode-uri" },
          },
        ]),
      );

      expect(result._tag).toBe("Left");
    }),
  );

  it.effect("rejects notebook cell context", () =>
    Effect.gen(function* () {
      const cell = createNotebookCell(
        createTestNotebookDocument("/test/notebook_mo.py"),
        { kind: 2, value: "x = 1", languageId: "python" },
        0,
      );

      const result = yield* Effect.either(
        decodeCommandArguments(restartKernelCommand, [cell]),
      );

      expect(result._tag).toBe("Left");
    }),
  );
});
