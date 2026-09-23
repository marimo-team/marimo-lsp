import { expect } from "@effect/vitest";
import { Effect, Option } from "effect";
import { vi } from "vitest";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import openAsMarimoNotebook from "../openAsMarimoNotebook.ts";

const it = EffectTest.make(TestVsCode.layer);
const fileIt = EffectTest.make(
  TestVsCode.layerWith({
    fileSystem: new Map([
      [
        "file:///test/notebook.py",
        new TextEncoder().encode("import marimo\napp = marimo.App()\n"),
      ],
    ]),
  }),
);

fileIt.effect(
  "opens a native VS Code URI passed by an editor action",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const uri = TestVsCode.Uri.file("/test/notebook.py");

    yield* openAsMarimoNotebook.invoke(uri);

    expect((yield* vscode.snapshot).executions).toEqual([
      {
        command: "vscode.openWith",
        args: [uri, NOTEBOOK_TYPE],
      },
    ]);
  }),
);

fileIt.effect(
  "parses and opens a URI string passed by a programmatic caller",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;

    yield* openAsMarimoNotebook.invoke("file:///test/notebook.py");

    const { executions } = yield* vscode.snapshot;
    expect(executions).toHaveLength(1);
    expect(executions[0]?.command).toBe("vscode.openWith");
    expect(executions[0]?.args[0]?.toString()).toBe("file:///test/notebook.py");
    expect(executions[0]?.args[1]).toBe(NOTEBOOK_TYPE);
  }),
);

it.effect(
  "opens the active editor when called without an argument",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const document = TestVsCode.createTestTextDocument(
      "/test/notebook.py",
      "python",
      "app = marimo.App()",
    );
    yield* vscode.setActiveTextEditor(
      Option.some(TestVsCode.createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook.invoke();

    expect((yield* vscode.snapshot).executions).toEqual([
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
    const vscode = yield* TestVsCode.Service;
    const document = TestVsCode.createTestTextDocument(
      "/test/notebook.py",
      "python",
      "app = marimo.App()\nx = 1",
    );
    Object.defineProperty(document, "isDirty", { value: true });
    const save = vi.spyOn(document, "save").mockResolvedValue(true);
    yield* vscode.setActiveTextEditor(
      Option.some(TestVsCode.createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook.invoke(document.uri.toString());

    expect(save).toHaveBeenCalledOnce();
    expect((yield* vscode.snapshot).executions).toEqual([
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
    const vscode = yield* TestVsCode.Service;
    const document = TestVsCode.createTestTextDocument(
      "/test/notebook.py",
      "python",
      "app = marimo.App()",
    );
    const save = vi.spyOn(document, "save");
    yield* vscode.setActiveTextEditor(
      Option.some(TestVsCode.createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook.invoke();

    expect(save).not.toHaveBeenCalled();
  }),
);

it.effect(
  "does not open the notebook when saving the dirty buffer fails",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const document = TestVsCode.createTestTextDocument(
      "/test/notebook.py",
      "python",
      "app = marimo.App()\nx = 1",
    );
    Object.defineProperty(document, "isDirty", { value: true });
    const save = vi.spyOn(document, "save").mockResolvedValue(false);
    yield* vscode.setActiveTextEditor(
      Option.some(TestVsCode.createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook.invoke();

    expect(save).toHaveBeenCalledOnce();
    expect((yield* vscode.snapshot).executions).toEqual([]);
  }),
);
