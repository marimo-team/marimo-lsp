import * as Vitest from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import * as MarimoFileDetector from "../MarimoFileDetector.ts";

const layerWith = (vscode: typeof VsCodeTest.layer) =>
  Layer.empty.pipe(
    Layer.provideMerge(MarimoFileDetector.layer),
    Layer.provideMerge(vscode),
  );

const it = EffectTest.make(layerWith(VsCodeTest.layer));

it.effect(
  "should be false on initialization without active editor",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    Vitest.expect((yield* vscode.snapshot).executions).toEqual([
      {
        command: "setContext",
        args: ["marimo.isPythonFileMarimoNotebook", false],
      },
    ]);
  }),
);

Vitest.it.effect.each([
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
  Effect.fn(function* ([_, pythonCode]) {
    const editor = VsCodeTest.createTestTextEditor(
      VsCodeTest.createTestTextDocument(
        "/test/notebook.py",
        "python",
        pythonCode,
      ),
    );
    const layer = layerWith(
      VsCodeTest.layerWith({
        initialActiveTextEditor: Option.some(editor),
      }),
    );
    const snapshot = yield* VsCodeTest.Service.pipe(
      Effect.flatMap((vscode) => vscode.snapshot),
      Effect.provide(layer),
    );

    Vitest.expect(snapshot.executions).toEqual([
      {
        command: "setContext",
        args: ["marimo.isPythonFileMarimoNotebook", true],
      },
    ]);
  }),
);

it.effect(
  "should set context to true for valid marimo notebook",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const pythonCode = `import marimo

app = marimo.App()

@app.cell
def __():
    return

if __name__ == "__main__":
    app.run()
`;

    const editor = VsCodeTest.createTestTextEditor(
      VsCodeTest.createTestTextDocument(
        "/test/notebook.py",
        "python",
        pythonCode,
      ),
    );
    const before = (yield* vscode.snapshot).executions.length;

    yield* vscode.setActiveTextEditor(Option.some(editor));
    yield* vscode.awaitExecutions((executions) => executions.length > before);

    Vitest.expect((yield* vscode.snapshot).executions.slice(before)).toEqual([
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
  Effect.fn(function* ([_, pythonCode]) {
    const vscode = yield* VsCodeTest.Service;
    const editor = VsCodeTest.createTestTextEditor(
      VsCodeTest.createTestTextDocument(
        "/test/notebook.py",
        "python",
        pythonCode,
      ),
    );
    const before = (yield* vscode.snapshot).executions.length;

    yield* vscode.setActiveTextEditor(Option.some(editor));
    yield* vscode.awaitExecutions((executions) => executions.length > before);

    Vitest.expect((yield* vscode.snapshot).executions.slice(before)).toEqual([
      {
        command: "setContext",
        args: ["marimo.isPythonFileMarimoNotebook", false],
      },
    ]);
  }),
);
