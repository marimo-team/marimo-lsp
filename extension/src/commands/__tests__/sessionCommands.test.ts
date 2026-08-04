import { expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import {
  createTestNotebookDocument,
  TestVsCode,
  Uri,
} from "../../__mocks__/TestVsCode.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import openSession from "../openSession.ts";

const NOTEBOOK_URI = notebookId("file:///workspace/notebook.py");

it.effect(
  "uses an existing marimo notebook document instead of reopening the file",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make();
    const document = createTestNotebookDocument(Uri.parse(NOTEBOOK_URI));
    yield* vscode.addNotebookDocument(document);

    yield* openSession
      .invoke({ notebookUri: NOTEBOOK_URI })
      .pipe(Effect.provide(vscode.layer));

    expect(yield* Ref.get(vscode.executions)).toEqual([]);
  }),
);

it.effect(
  "explicitly opens a background session with the marimo notebook editor",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make();

    yield* openSession
      .invoke({ notebookUri: NOTEBOOK_URI })
      .pipe(Effect.provide(vscode.layer));

    const executions = yield* Ref.get(vscode.executions);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.command).toBe("vscode.openWith");
    expect(executions[0]?.args[0]).toEqual(Uri.parse(NOTEBOOK_URI));
    expect(executions[0]?.args[1]).toBe(NOTEBOOK_TYPE);
  }),
);

it.effect(
  "matches an already-open notebook using its unescaped URI",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make();
    const rawUri = notebookId("file:///workspace/notebook with spaces.py");
    const document = createTestNotebookDocument(
      Uri.file("/workspace/notebook with spaces.py"),
    );
    yield* vscode.addNotebookDocument(document);

    yield* openSession
      .invoke({ notebookUri: rawUri })
      .pipe(Effect.provide(vscode.layer));

    expect(yield* Ref.get(vscode.executions)).toEqual([]);
  }),
);
