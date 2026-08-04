import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  createNotebookCell,
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { decodeCommandArguments } from "../../commands.ts";
import restartKernel from "../restartKernel.ts";

describe("restartKernel invocation", () => {
  it.effect("resolves the notebook referenced by toolbar context", () =>
    Effect.gen(function* () {
      const target = TestVsCode.makeNotebookEditor("/test/target.py");
      const active = TestVsCode.makeNotebookEditor("/test/active.py");
      const vscode = yield* TestVsCode.make({
        initialDocuments: [target.notebook, active.notebook],
      });
      yield* vscode.setActiveNotebookEditor(Option.some(target));
      yield* vscode.setActiveNotebookEditor(Option.some(active));

      const [resolved] = yield* decodeCommandArguments(restartKernel.command, [
        { notebookEditor: { notebookUri: target.notebook.uri } },
      ]).pipe(Effect.provide(vscode.layer));

      expect(Option.getOrThrow(resolved).editor).toBe(target);
    }),
  );

  it.effect("uses the active notebook without toolbar context", () =>
    Effect.gen(function* () {
      const active = TestVsCode.makeNotebookEditor("/test/active.py");
      const vscode = yield* TestVsCode.make({
        initialDocuments: [active.notebook],
      });
      yield* vscode.setActiveNotebookEditor(Option.some(active));

      const [resolved] = yield* decodeCommandArguments(
        restartKernel.command,
        [],
      ).pipe(Effect.provide(vscode.layer));

      expect(Option.getOrThrow(resolved).editor).toBe(active);
    }),
  );

  it.effect("falls back for an incomplete toolbar lifecycle hint", () =>
    Effect.gen(function* () {
      const active = TestVsCode.makeNotebookEditor("/test/active.py");
      const vscode = yield* TestVsCode.make({
        initialDocuments: [active.notebook],
      });
      yield* vscode.setActiveNotebookEditor(Option.some(active));

      const [resolved] = yield* decodeCommandArguments(restartKernel.command, [
        {
          ui: true,
          source: "notebookToolbar",
          notebookEditor: {},
        },
      ]).pipe(Effect.provide(vscode.layer));

      expect(Option.getOrThrow(resolved).editor).toBe(active);
    }),
  );

  it.effect("rejects unrelated UI metadata", () =>
    Effect.gen(function* () {
      const vscode = yield* TestVsCode.make();
      const result = yield* Effect.either(
        decodeCommandArguments(restartKernel.command, [
          { ui: true, source: "editorToolbar", notebookEditor: {} },
        ]).pipe(Effect.provide(vscode.layer)),
      );
      expect(result._tag).toBe("Left");
    }),
  );

  it.effect("rejects notebook-cell context", () =>
    Effect.gen(function* () {
      const vscode = yield* TestVsCode.make();
      const cell = createNotebookCell(
        createTestNotebookDocument("/test/notebook_mo.py"),
        { kind: 2, value: "x = 1", languageId: "python" },
        0,
      );
      const result = yield* Effect.either(
        decodeCommandArguments(restartKernel.command, [cell]).pipe(
          Effect.provide(vscode.layer),
        ),
      );
      expect(result._tag).toBe("Left");
    }),
  );
});
