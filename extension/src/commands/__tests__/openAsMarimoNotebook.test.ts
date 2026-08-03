import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { vi } from "vitest";

import {
  createTestTextDocument,
  createTestTextEditor,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { makeTestMarimoClient } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { openAsMarimoNotebook } from "../openAsMarimoNotebook.ts";

const nativeNotebook = {
  kind: "success",
  notebook: {
    notebook: { version: "1", cells: [], metadata: {} },
  },
} as const;

function provideCommand(vscode: TestVsCode, result: unknown = nativeNotebook) {
  return Effect.provide(
    Layer.merge(
      vscode.layer,
      makeTestMarimoClient({ execute: () => Effect.succeed(result) }),
    ),
  );
}

it.effect(
  "opens a native VS Code URI passed by an editor action",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make({
      fileSystem: new Map([
        [
          "file:///test/notebook.py",
          new TextEncoder().encode("import marimo\napp = marimo.App()\n"),
        ],
      ]),
    });
    const uri = vscode.createMockUri("/test/notebook.py");

    yield* openAsMarimoNotebook(uri).pipe(provideCommand(vscode));

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
    const vscode = yield* TestVsCode.make({
      fileSystem: new Map([
        [
          "file:///test/notebook.py",
          new TextEncoder().encode("import marimo\napp = marimo.App()\n"),
        ],
      ]),
    });

    yield* openAsMarimoNotebook("file:///test/notebook.py").pipe(
      provideCommand(vscode),
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

    yield* openAsMarimoNotebook().pipe(provideCommand(vscode));

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
      provideCommand(vscode),
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

    yield* openAsMarimoNotebook().pipe(provideCommand(vscode));

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

    yield* openAsMarimoNotebook().pipe(provideCommand(vscode));

    expect(save).toHaveBeenCalledOnce();
    expect(yield* vscode.executions).toEqual([]);
  }),
);

it.effect(
  "keeps unrecoverable syntax open as text with a line-aware message",
  Effect.fn(function* () {
    const messages: string[] = [];
    const vscode = yield* TestVsCode.make({
      window: {
        showErrorMessage(message) {
          messages.push(message);
          return Effect.succeed(Option.none());
        },
      },
    });
    const document = createTestTextDocument(
      "/test/notebook.py",
      "python",
      "invalid source",
    );
    yield* vscode.setActiveTextEditor(
      Option.some(createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook().pipe(
      provideCommand(vscode, {
        kind: "invalid-syntax",
        message: "The file contains invalid Python syntax.",
        line: 7,
        column: 3,
      }),
    );

    expect(messages).toEqual([
      "This file can't be opened as a marimo notebook because it has a Python syntax error at line 7.",
    ]);
    expect(yield* vscode.executions).toEqual([]);
  }),
);

it.effect(
  "offers to convert non-marimo Python into a copy",
  Effect.fn(function* () {
    const messages: string[] = [];
    const vscode = yield* TestVsCode.make({
      window: {
        showInformationMessage(message, options) {
          messages.push(message);
          return Effect.succeed(Option.fromNullable(options?.items?.[0]));
        },
      },
    });
    const document = createTestTextDocument(
      "/test/script.py",
      "python",
      "print('hello')",
    );
    yield* vscode.setActiveTextEditor(
      Option.some(createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook().pipe(
      provideCommand(vscode, {
        kind: "not-marimo",
        message: "The file is not a native marimo notebook.",
      }),
    );

    expect(messages).toEqual([
      "This is a Python script, not a native marimo notebook.",
    ]);
    expect(yield* vscode.executions).toEqual([
      {
        command: "marimo.convert",
        args: [{ uri: "file:///test/script.py" }],
      },
    ]);
  }),
);
