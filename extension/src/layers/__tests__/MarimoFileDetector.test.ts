import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, TestClock } from "effect";
import {
  createTestTextDocument,
  createTestTextEditor,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { MarimoFileDetectorLive } from "../MarimoFileDetector.ts";

const withTestCtx = Effect.fnUntraced(function* () {
  const vscode = yield* TestVsCode.make();
  const layer = Layer.empty.pipe(
    Layer.provideMerge(MarimoFileDetectorLive),
    Layer.provide(vscode.layer),
  );
  return { vscode, layer };
});

it.effect(
  "should be false on intialization without active editor",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    // build the layer
    yield* Effect.provide(Effect.void, ctx.layer);
    expect(yield* ctx.vscode.executions).toMatchInlineSnapshot(`
      [
        {
          "args": [
            "marimo.isPythonFileMarimoNotebook",
            false,
          ],
          "command": "setContext",
        },
      ]
    `);
  }),
);

it.effect(
  "should be true on intialization with active editor",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    const pythonCode = `import marimo

app = marimo.App()

@app.cell
def __():
    return

if __name__ == "__main__":
    app.run()
`;

    const editor = createTestTextEditor(
      createTestTextDocument("/test/notebook.py", "python", pythonCode),
    );
    // set the active notebook editor prior to intialization
    yield* ctx.vscode.setActiveTextEditor(Option.some(editor));

    // build the layer
    yield* Effect.provide(Effect.void, ctx.layer);
    expect(yield* ctx.vscode.executions).toMatchInlineSnapshot(`
      [
        {
          "args": [
            "marimo.isPythonFileMarimoNotebook",
            true,
          ],
          "command": "setContext",
        },
      ]
    `);
  }),
);

it.effect(
  "should set context to true for valid marimo notebook",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    const pythonCode = `import marimo

app = marimo.App()

@app.cell
def __():
    return

if __name__ == "__main__":
    app.run()
`;

    const editor = createTestTextEditor(
      createTestTextDocument("/test/notebook.py", "python", pythonCode),
    );

    yield* Effect.gen(function* () {
      // clear initialization
      yield* Ref.set(ctx.vscode.executions, []);

      // Set the active text editor
      yield* ctx.vscode.setActiveTextEditor(Option.some(editor));
      // Give the detector time to process the change
      yield* TestClock.adjust("100 millis");
    }).pipe(Effect.provide(ctx.layer));

    expect(yield* ctx.vscode.executions).toMatchInlineSnapshot(`
      [
        {
          "args": [
            "marimo.isPythonFileMarimoNotebook",
            true,
          ],
          "command": "setContext",
        },
      ]
    `);
  }),
);

it.effect(
  "should set context to false for regular Python file",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    const pythonCode = `import pandas as pd
def main():
    print(pd)

if __name__ == "__main__":
    main()
`;
    const editor = createTestTextEditor(
      createTestTextDocument("/test/notebook.py", "python", pythonCode),
    );

    // Set the active editor and wait for changes to process
    yield* Effect.gen(function* () {
      // clear initialization
      yield* Ref.set(ctx.vscode.executions, []);

      // set new notebook
      yield* ctx.vscode.setActiveTextEditor(Option.some(editor));
      yield* TestClock.adjust("100 millis");
    }).pipe(Effect.provide(ctx.layer));

    expect(yield* ctx.vscode.executions).toMatchInlineSnapshot(`
      [
        {
          "args": [
            "marimo.isPythonFileMarimoNotebook",
            false,
          ],
          "command": "setContext",
        },
      ]
    `);
  }),
);
