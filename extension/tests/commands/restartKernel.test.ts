import * as Vitest from "@effect/vitest";
import { Effect, Option } from "effect";

import { decodeCommandArguments } from "../../src/commands.ts";
import restartKernel from "../../src/commands/restartKernel.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const test = EffectTest.make(VsCodeTest.layer);

Vitest.describe("restartKernel invocation", () => {
  test.effect("resolves the notebook referenced by toolbar context", () =>
    Effect.gen(function* () {
      const target = VsCodeTest.makeNotebookEditor("/test/target.py");
      const active = VsCodeTest.makeNotebookEditor("/test/active.py");
      const vscode = yield* VsCodeTest.Service;
      yield* vscode.openNotebook(target.notebook);
      yield* vscode.openNotebook(active.notebook);
      // Activating an editor is what makes it visible; the toolbar context
      // resolves against visible editors, so `target` must be shown once.
      yield* vscode.setActiveNotebookEditor(Option.some(target));
      yield* vscode.setActiveNotebookEditor(Option.some(active));

      const [resolved] = yield* decodeCommandArguments(restartKernel.command, [
        { notebookEditor: { notebookUri: target.notebook.uri } },
      ]);

      Vitest.expect(Option.getOrThrow(resolved).editor).toBe(target);
    }),
  );

  test.effect("uses the active notebook without toolbar context", () =>
    Effect.gen(function* () {
      const active = VsCodeTest.makeNotebookEditor("/test/active.py");
      const vscode = yield* VsCodeTest.Service;
      yield* vscode.openNotebook(active.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(active));

      const [resolved] = yield* decodeCommandArguments(
        restartKernel.command,
        [],
      );

      Vitest.expect(Option.getOrThrow(resolved).editor).toBe(active);
    }),
  );

  test.effect("falls back for an incomplete toolbar lifecycle hint", () =>
    Effect.gen(function* () {
      const active = VsCodeTest.makeNotebookEditor("/test/active.py");
      const vscode = yield* VsCodeTest.Service;
      yield* vscode.openNotebook(active.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(active));

      const [resolved] = yield* decodeCommandArguments(restartKernel.command, [
        {
          ui: true,
          source: "notebookToolbar",
          notebookEditor: {},
        },
      ]);

      Vitest.expect(Option.getOrThrow(resolved).editor).toBe(active);
    }),
  );

  test.effect("rejects unrelated UI metadata", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeCommandArguments(restartKernel.command, [
          { ui: true, source: "editorToolbar", notebookEditor: {} },
        ]),
      );
      Vitest.expect(result._tag).toBe("Failure");
    }),
  );

  test.effect("rejects notebook-cell context", () =>
    Effect.gen(function* () {
      const cell = VsCodeTest.createNotebookCell(
        VsCodeTest.createTestNotebookDocument("/test/notebook_mo.py"),
        { kind: 2, value: "x = 1", languageId: "python" },
        0,
      );
      const result = yield* Effect.result(
        decodeCommandArguments(restartKernel.command, [cell]),
      );
      Vitest.expect(result._tag).toBe("Failure");
    }),
  );
});
