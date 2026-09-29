import * as Vitest from "@effect/vitest";
import { Effect, Option } from "effect";
import { vi } from "vitest";

import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import openAsMarimoNotebook from "../openAsMarimoNotebook.ts";

const it = EffectTest.make(VsCodeTest.layer);
const fileIt = EffectTest.make(
  VsCodeTest.layerWith({
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
    const vscode = yield* VsCodeTest.Service;
    const uri = VsCodeTest.Uri.file("/test/notebook.py");

    yield* openAsMarimoNotebook.invoke(uri);

    Vitest.expect((yield* vscode.snapshot).executions).toEqual([
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
    const vscode = yield* VsCodeTest.Service;

    yield* openAsMarimoNotebook.invoke("file:///test/notebook.py");

    const { executions } = yield* vscode.snapshot;
    Vitest.expect(executions).toHaveLength(1);
    Vitest.expect(executions[0]?.command).toBe("vscode.openWith");
    Vitest.expect(executions[0]?.args[0]?.toString()).toBe(
      "file:///test/notebook.py",
    );
    Vitest.expect(executions[0]?.args[1]).toBe(NOTEBOOK_TYPE);
  }),
);

it.effect(
  "opens the active editor when called without an argument",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const document = VsCodeTest.createTestTextDocument(
      "/test/notebook.py",
      "python",
      "app = marimo.App()",
    );
    yield* vscode.setActiveTextEditor(
      Option.some(VsCodeTest.createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook.invoke();

    Vitest.expect((yield* vscode.snapshot).executions).toEqual([
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
    const vscode = yield* VsCodeTest.Service;
    const document = VsCodeTest.createTestTextDocument(
      "/test/notebook.py",
      "python",
      "app = marimo.App()\nx = 1",
    );
    Object.defineProperty(document, "isDirty", { value: true });
    const save = vi.spyOn(document, "save").mockResolvedValue(true);
    yield* vscode.setActiveTextEditor(
      Option.some(VsCodeTest.createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook.invoke(document.uri.toString());

    Vitest.expect(save).toHaveBeenCalledOnce();
    Vitest.expect((yield* vscode.snapshot).executions).toEqual([
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
    const vscode = yield* VsCodeTest.Service;
    const document = VsCodeTest.createTestTextDocument(
      "/test/notebook.py",
      "python",
      "app = marimo.App()",
    );
    const save = vi.spyOn(document, "save");
    yield* vscode.setActiveTextEditor(
      Option.some(VsCodeTest.createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook.invoke();

    Vitest.expect(save).not.toHaveBeenCalled();
  }),
);

it.effect(
  "does not open the notebook when saving the dirty buffer fails",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const document = VsCodeTest.createTestTextDocument(
      "/test/notebook.py",
      "python",
      "app = marimo.App()\nx = 1",
    );
    Object.defineProperty(document, "isDirty", { value: true });
    const save = vi.spyOn(document, "save").mockResolvedValue(false);
    yield* vscode.setActiveTextEditor(
      Option.some(VsCodeTest.createTestTextEditor(document)),
    );

    yield* openAsMarimoNotebook.invoke();

    Vitest.expect(save).toHaveBeenCalledOnce();
    Vitest.expect((yield* vscode.snapshot).executions).toEqual([]);
  }),
);
