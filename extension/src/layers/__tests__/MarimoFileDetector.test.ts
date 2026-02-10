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
  "should be false on initialization without active editor",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    // build the layer
    yield* Effect.provide(Effect.void, ctx.layer);
    expect(yield* ctx.vscode.executions).toEqual([
      {
        command: "setContext",
        args: ["marimo.isPythonFileMarimoNotebook", false],
      },
    ]);
  }),
);

it.effect.each([
  [
    "basic marimo app",
    `import marimo

app = marimo.App()
`,
  ],
  [
    "marimo app with kwargs",
    `import marimo

app = marimo.App(some=10, kwargs="20")
`,
  ],
  ["minimal marimo app without import", `app = marimo.App()`],
  [
    "marimo app with no whitespace around equals",
    `import marimo
app=marimo.App()`,
  ],
  [
    "marimo app with extra whitespace",
    `import marimo
app  =  marimo.App()`,
  ],
  [
    "marimo app with tabs",
    `import marimo
app\t=\tmarimo.App()`,
  ],
  [
    "marimo app with comment above",
    `import marimo

# Initialize the app
app = marimo.App()`,
  ],
  [
    "marimo app with type annotation",
    `import marimo

app: marimo.App = marimo.App()`,
  ],
  [
    "complete marimo notebook with cells",
    `import marimo

app = marimo.App(width="medium")

@app.cell
def __():
    import numpy as np
    return

if __name__ == "__main__":
    app.run()
`,
  ],
] as const)(
  "should be true on initialization with active editor: %s",
  Effect.fnUntraced(function* ([_, pythonCode]) {
    const ctx = yield* withTestCtx();

    const editor = createTestTextEditor(
      createTestTextDocument("/test/notebook.py", "python", pythonCode),
    );
    // set the active notebook editor prior to initialization
    yield* ctx.vscode.setActiveTextEditor(Option.some(editor));

    // build the layer
    yield* Effect.provide(Effect.void, ctx.layer);

    expect(yield* ctx.vscode.executions).toEqual([
      {
        command: "setContext",
        args: ["marimo.isPythonFileMarimoNotebook", true],
      },
    ]);
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

    expect(yield* ctx.vscode.executions).toEqual([
      {
        command: "setContext",
        args: ["marimo.isPythonFileMarimoNotebook", true],
      },
    ]);
  }),
);

it.effect.each([
  [
    "regular Python script",
    `import pandas as pd
def main():
    print(pd)

if __name__ == "__main__":
    main()
`,
  ],
  [
    "imports marimo but doesn't create an app",
    `import marimo

def helper():
    pass
`,
  ],
  [
    "marimo.App in a string literal",
    `code = "app = marimo.App()"
print(code)
`,
  ],
  [
    "marimo.App in a comment",
    `# This file uses app = marimo.App() syntax
import other_lib
`,
  ],
  [
    "marimo.App indented inside a function",
    `import marimo

def create_app():
    app = marimo.App()
    return app
`,
  ],
  [
    "marimo.App indented inside a class",
    `import marimo

class NotebookManager:
    def __init__(self):
        self.app = marimo.App()
`,
  ],
  [
    "unrelated code mentioning marimo",
    `my_app = some_other_framework.App()
marimo_reference = "check marimo.App docs"
`,
  ],
  [
    "marimo.App called without assignment",
    `import marimo
marimo.App().run()
`,
  ],
  [
    "wrong variable name (not 'app')",
    `import marimo
my_app = marimo.App()
`,
  ],
  [
    "only imports marimo",
    `import marimo
`,
  ],
] as const)(
  "should set context to false for non-marimo Python files: %s",
  Effect.fnUntraced(function* ([_, pythonCode]) {
    const ctx = yield* withTestCtx();
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

    expect(yield* ctx.vscode.executions).toEqual([
      {
        command: "setContext",
        args: ["marimo.isPythonFileMarimoNotebook", false],
      },
    ]);
  }),
);
