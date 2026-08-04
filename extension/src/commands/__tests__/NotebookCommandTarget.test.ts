import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { createNotebookCell, TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { getNotebookCommandEditor } from "../NotebookCommandTarget.ts";

describe("getNotebookCommandEditor", () => {
  it.effect("prefers the notebook referenced by toolbar context", () =>
    Effect.gen(function* () {
      const target = TestVsCode.makeNotebookEditor("/test/target.py");
      const active = TestVsCode.makeNotebookEditor("/test/active.py");
      const vscode = yield* TestVsCode.make({
        initialDocuments: [target.notebook, active.notebook],
      });

      yield* vscode.setActiveNotebookEditor(Option.some(target));
      yield* vscode.setActiveNotebookEditor(Option.some(active));

      const editor = yield* getNotebookCommandEditor({
        notebookEditor: { notebookUri: target.notebook.uri },
      }).pipe(Effect.provide(vscode.layer));

      expect(Option.getOrThrow(editor).notebook.uri.toString()).toBe(
        target.notebook.uri.toString(),
      );
    }),
  );

  it.effect("falls back to the active notebook without toolbar context", () =>
    Effect.gen(function* () {
      const active = TestVsCode.makeNotebookEditor("/test/active.py");
      const vscode = yield* TestVsCode.make({
        initialDocuments: [active.notebook],
      });
      yield* vscode.setActiveNotebookEditor(Option.some(active));

      const editor = yield* getNotebookCommandEditor().pipe(
        Effect.provide(vscode.layer),
      );

      expect(Option.getOrThrow(editor)).toBe(active);
    }),
  );

  it.effect(
    "falls back to the active notebook when toolbar serialization omits its URI",
    () =>
      Effect.gen(function* () {
        const active = TestVsCode.makeNotebookEditor("/test/active.py");
        const vscode = yield* TestVsCode.make({
          initialDocuments: [active.notebook],
        });
        yield* vscode.setActiveNotebookEditor(Option.some(active));

        const editor = yield* getNotebookCommandEditor({
          ui: true,
          source: "notebookToolbar",
          notebookEditor: {},
        }).pipe(Effect.provide(vscode.layer));

        expect(Option.getOrThrow(editor)).toBe(active);
      }),
  );

  it.effect("resolves the notebook referenced by cell context", () =>
    Effect.gen(function* () {
      const target = TestVsCode.makeNotebookEditor("/test/target.py");
      const active = TestVsCode.makeNotebookEditor("/test/active.py");
      const vscode = yield* TestVsCode.make({
        initialDocuments: [target.notebook, active.notebook],
      });
      yield* vscode.setActiveNotebookEditor(Option.some(target));
      yield* vscode.setActiveNotebookEditor(Option.some(active));

      const cell = createNotebookCell(
        target.notebook,
        { kind: 2, value: "x = 1", languageId: "python" },
        0,
      );
      const editor = yield* getNotebookCommandEditor(cell).pipe(
        Effect.provide(vscode.layer),
      );

      expect(Option.getOrThrow(editor).notebook.uri.toString()).toBe(
        target.notebook.uri.toString(),
      );
    }),
  );

  it.effect(
    "does not target the active notebook when context is unresolved",
    () =>
      Effect.gen(function* () {
        const active = TestVsCode.makeNotebookEditor("/test/active.py");
        const missing = TestVsCode.makeNotebookEditor("/test/missing.py");
        const vscode = yield* TestVsCode.make({
          initialDocuments: [active.notebook],
        });
        yield* vscode.setActiveNotebookEditor(Option.some(active));

        const editor = yield* getNotebookCommandEditor({
          notebookEditor: { notebookUri: missing.notebook.uri },
        }).pipe(Effect.provide(vscode.layer));

        expect(Option.isNone(editor)).toBe(true);
      }),
  );
});
