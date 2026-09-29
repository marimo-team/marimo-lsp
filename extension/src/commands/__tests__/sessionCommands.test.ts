import * as Vitest from "@effect/vitest";
import { Effect } from "effect";

import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import openSession from "../openSession.ts";

const NOTEBOOK_URI = notebookId("file:///workspace/notebook.py");
const it = EffectTest.make(VsCodeTest.layer);

it.effect(
  "uses an existing marimo notebook document instead of reopening the file",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const document = VsCodeTest.createTestNotebookDocument(
      VsCodeTest.Uri.parse(NOTEBOOK_URI),
    );
    yield* vscode.openNotebook(document);

    yield* openSession.invoke({ notebookUri: NOTEBOOK_URI });

    Vitest.expect((yield* vscode.snapshot).executions).toEqual([]);
  }),
);

it.effect(
  "explicitly opens a background session with the marimo notebook editor",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;

    yield* openSession.invoke({ notebookUri: NOTEBOOK_URI });

    const { executions } = yield* vscode.snapshot;
    Vitest.expect(executions).toHaveLength(1);
    Vitest.expect(executions[0]?.command).toBe("vscode.openWith");
    Vitest.expect(executions[0]?.args[0]).toEqual(
      VsCodeTest.Uri.parse(NOTEBOOK_URI),
    );
    Vitest.expect(executions[0]?.args[1]).toBe(NOTEBOOK_TYPE);
  }),
);

it.effect(
  "matches an already-open notebook using its unescaped URI",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const rawUri = notebookId("file:///workspace/notebook with spaces.py");
    const document = VsCodeTest.createTestNotebookDocument(
      VsCodeTest.Uri.file("/workspace/notebook with spaces.py"),
    );
    yield* vscode.openNotebook(document);

    yield* openSession.invoke({ notebookUri: rawUri });

    Vitest.expect((yield* vscode.snapshot).executions).toEqual([]);
  }),
);
