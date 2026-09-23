import { describe, expect } from "@effect/vitest";
import { Effect, Option } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { decodeCommandArguments } from "../../commands.ts";
import restartKernel from "../restartKernel.ts";

const test = EffectTest.make(TestVsCode.layer);

describe("restartKernel invocation", () => {
  test.effect("resolves the notebook referenced by toolbar context", () =>
    Effect.gen(function* () {
      const target = TestVsCode.makeNotebookEditor("/test/target.py");
      const active = TestVsCode.makeNotebookEditor("/test/active.py");
      const vscode = yield* TestVsCode.Service;
      yield* vscode.openNotebook(target.notebook);
      yield* vscode.openNotebook(active.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(target));
      yield* vscode.setActiveNotebookEditor(Option.some(active));

      const [resolved] = yield* decodeCommandArguments(restartKernel.command, [
        { notebookEditor: { notebookUri: target.notebook.uri } },
      ]);

      expect(Option.getOrThrow(resolved).editor).toBe(target);
    }),
  );

  test.effect("uses the active notebook without toolbar context", () =>
    Effect.gen(function* () {
      const active = TestVsCode.makeNotebookEditor("/test/active.py");
      const vscode = yield* TestVsCode.Service;
      yield* vscode.openNotebook(active.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(active));

      const [resolved] = yield* decodeCommandArguments(
        restartKernel.command,
        [],
      );

      expect(Option.getOrThrow(resolved).editor).toBe(active);
    }),
  );

  test.effect("falls back for an incomplete toolbar lifecycle hint", () =>
    Effect.gen(function* () {
      const active = TestVsCode.makeNotebookEditor("/test/active.py");
      const vscode = yield* TestVsCode.Service;
      yield* vscode.openNotebook(active.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(active));

      const [resolved] = yield* decodeCommandArguments(restartKernel.command, [
        {
          ui: true,
          source: "notebookToolbar",
          notebookEditor: {},
        },
      ]);

      expect(Option.getOrThrow(resolved).editor).toBe(active);
    }),
  );

  test.effect("rejects unrelated UI metadata", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeCommandArguments(restartKernel.command, [
          { ui: true, source: "editorToolbar", notebookEditor: {} },
        ]),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  test.effect("rejects notebook-cell context", () =>
    Effect.gen(function* () {
      const cell = TestVsCode.createNotebookCell(
        TestVsCode.createTestNotebookDocument("/test/notebook_mo.py"),
        { kind: 2, value: "x = 1", languageId: "python" },
        0,
      );
      const result = yield* Effect.result(
        decodeCommandArguments(restartKernel.command, [cell]),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
