import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { vi } from "vitest";

import {
  createTestTextDocument,
  createTestTextEditor,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { openAsMarimoNotebook } from "../openAsMarimoNotebook.ts";

it.effect(
  "opens a native VS Code URI passed by an editor action",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make();
    const uri = vscode.createMockUri("/test/notebook.py");

    yield* openAsMarimoNotebook(uri).pipe(Effect.provide(vscode.layer));

    expect(yield* vscode.executions).toEqual([
      {
        command: "vscode.openWith",
        args: [uri, NOTEBOOK_TYPE],
      },
    ]);
  }),
);

it.effect(
  "parses and opens a URI string passed by a programmatic caller",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make();

    yield* openAsMarimoNotebook("file:///test/notebook.py").pipe(
      Effect.provide(vscode.layer),
    );

    const executions = yield* vscode.executions;
    expect(executions).toHaveLength(1);
    expect(executions[0]?.command).toBe("vscode.openWith");
    expect(executions[0]?.args[0]?.toString()).toBe("file:///test/notebook.py");
    expect(executions[0]?.args[1]).toBe(NOTEBOOK_TYPE);
  }),
);

it.effect(
  "opens the active editor when called without an argument",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make();
    const document = createTestTextDocument(
      "/test/notebook.py",
      "python",
      "app = marimo.App()",
    );
    yield* vscode.setActiveTextEditor(
      Option.some(createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook().pipe(Effect.provide(vscode.layer));

    expect(yield* vscode.executions).toEqual([
      {
        command: "vscode.openWith",
        args: [document.uri, NOTEBOOK_TYPE],
      },
    ]);
  }),
);

it.effect(
  "saves an unsaved buffer before opening it from a URI string (#531)",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make();
    const document = createTestTextDocument(
      "/test/notebook.py",
      "python",
      "app = marimo.App()\nx = 1",
    );
    Object.defineProperty(document, "isDirty", { value: true });
    const save = vi.spyOn(document, "save").mockResolvedValue(true);
    yield* vscode.setActiveTextEditor(
      Option.some(createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook(document.uri.toString()).pipe(
      Effect.provide(vscode.layer),
    );

    expect(save).toHaveBeenCalledOnce();
    expect(yield* vscode.executions).toEqual([
      {
        command: "vscode.openWith",
        args: [document.uri, NOTEBOOK_TYPE],
      },
    ]);
  }),
);

it.effect(
  "does not save a clean active buffer before opening it as a notebook",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make();
    const document = createTestTextDocument(
      "/test/notebook.py",
      "python",
      "app = marimo.App()",
    );
    const save = vi.spyOn(document, "save");
    yield* vscode.setActiveTextEditor(
      Option.some(createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook().pipe(Effect.provide(vscode.layer));

    expect(save).not.toHaveBeenCalled();
  }),
);

it.effect(
  "does not open the notebook when saving the dirty buffer fails",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make();
    const document = createTestTextDocument(
      "/test/notebook.py",
      "python",
      "app = marimo.App()\nx = 1",
    );
    Object.defineProperty(document, "isDirty", { value: true });
    const save = vi.spyOn(document, "save").mockResolvedValue(false);
    yield* vscode.setActiveTextEditor(
      Option.some(createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook().pipe(Effect.provide(vscode.layer));

    expect(save).toHaveBeenCalledOnce();
    expect(yield* vscode.executions).toEqual([]);
  }),
);
