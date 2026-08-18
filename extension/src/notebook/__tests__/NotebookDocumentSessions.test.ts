import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";

import {
  createTestNotebookDocument,
  TestVsCode,
  Uri,
} from "../../__mocks__/TestVsCode.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import { NotebookDocumentSessions } from "../NotebookDocumentSessions.ts";

it.effect(
  "ends the old session when a document is replaced at the same URI",
  Effect.fn(function* () {
    const uri = Uri.parse("file:///test/notebook.py");
    const id = notebookId(uri.toString());
    const first = createTestNotebookDocument(uri);
    const replacement = createTestNotebookDocument(uri);
    const vscode = yield* TestVsCode.make({ initialDocuments: [first] });
    const layer = NotebookDocumentSessions.layer.pipe(
      Layer.provideMerge(vscode.layer),
    );

    yield* Effect.gen(function* () {
      const sessions = yield* NotebookDocumentSessions;
      const firstSession = sessions.current(id);
      expect(firstSession?.document).toBe(first);
      if (firstSession === undefined) return;

      const firstEnded = yield* Effect.forkChild(firstSession.ended);
      yield* vscode.openNotebook(replacement);
      yield* Fiber.join(firstEnded);

      const replacementSession = sessions.current(id);
      expect(replacementSession?.document).toBe(replacement);
      expect(replacementSession).not.toBe(firstSession);
      if (replacementSession === undefined) return;

      // A delayed close for the displaced document cannot end its replacement.
      yield* vscode.closeNotebook(first);
      yield* Effect.yieldNow;
      expect(sessions.current(id)).toBe(replacementSession);

      const replacementEnded = yield* Effect.forkChild(
        replacementSession.ended,
      );
      yield* vscode.closeNotebook(replacement);
      yield* Fiber.join(replacementEnded);
      expect(sessions.current(id)).toBeUndefined();
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "ignores a replayed open for a document that already closed",
  Effect.fn(function* () {
    const uri = Uri.parse("file:///test/notebook.py");
    const id = notebookId(uri.toString());
    const first = createTestNotebookDocument(uri);
    const replacement = createTestNotebookDocument(uri);
    const vscode = yield* TestVsCode.make();
    // The lifecycle snapshot can hold a document that closes before the
    // consumer observes its open. Model that stale entry directly.
    yield* vscode.closeNotebook(first);
    yield* vscode.addNotebookDocument(first);
    const layer = NotebookDocumentSessions.layer.pipe(
      Layer.provideMerge(vscode.layer),
    );

    yield* Effect.gen(function* () {
      const sessions = yield* NotebookDocumentSessions;
      expect(sessions.current(id)).toBeUndefined();

      yield* vscode.openNotebook(replacement);
      yield* Effect.yieldNow;
      expect(sessions.current(id)?.document).toBe(replacement);
    }).pipe(Effect.provide(layer));
  }),
);
