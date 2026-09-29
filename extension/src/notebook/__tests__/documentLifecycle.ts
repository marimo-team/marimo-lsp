import { Effect, Fiber, Stream } from "effect";
import type * as vscode from "vscode";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as NotebookDocumentSessions from "../NotebookDocumentSessions.ts";

/** Waits for this document's transition, including finalizers, without changing focus. */
export const transition = Effect.fn("TestDocumentLifecycle.transition")(
  function* (document: vscode.NotebookDocument, type: "opened" | "closed") {
    const vscode = yield* TestVsCode.Service;
    const sessions = yield* NotebookDocumentSessions.Service;
    const lifecycle = yield* sessions.subscribeLifecycle;
    const processed = yield* lifecycle.pipe(
      Stream.filter(
        (event) => event.document === document && event.type === type,
      ),
      Stream.runHead,
      Effect.forkChild,
    );
    yield* type === "opened"
      ? vscode.openNotebook(document)
      : vscode.closeNotebook(document);
    yield* Fiber.join(processed);
  },
  Effect.scoped,
);
