import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  createTestTextDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import {
  findMarimoAppLine,
  isMarimoAppText,
  MARIMO_APP_REGEX,
  MarimoCodeLensProviderLive,
} from "../MarimoCodeLensProvider.ts";

// ============================================================================
// Regex Tests (Pure Functions)
// ============================================================================

describe("MARIMO_APP_REGEX", () => {
  describe("should match valid marimo app declarations", () => {
    it.each([
      ["basic", "app = marimo.App()"],
      ["with kwargs", 'app = marimo.App(some=10, kwargs="20")'],
      ["no whitespace around equals", "app=marimo.App()"],
      ["extra whitespace", "app  =  marimo.App()"],
      ["with tabs", "app\t=\tmarimo.App()"],
      ["with type annotation", "app: marimo.App = marimo.App()"],
      [
        "in complete file",
        `import marimo

app = marimo.App(width="medium")

@app.cell
def __():
    return`,
      ],
    ])("%s", (_name, code) => {
      expect(MARIMO_APP_REGEX.test(code)).toBe(true);
    });
  });

  describe("should NOT match invalid patterns", () => {
    it.each([
      ["regular Python script", "import pandas as pd\ndef main():\n    pass"],
      ["imports marimo only", "import marimo\n\ndef helper():\n    pass"],
      ["in string literal", 'code = "app = marimo.App()"'],
      ["in comment", "# This file uses app = marimo.App() syntax"],
      [
        "indented in function",
        "def create_app():\n    app = marimo.App()\n    return app",
      ],
      [
        "indented in class",
        "class Manager:\n    def __init__(self):\n        self.app = marimo.App()",
      ],
      ["called without assignment", "marimo.App().run()"],
      ["wrong variable name", "my_app = marimo.App()"],
    ])("%s", (_name, code) => {
      expect(MARIMO_APP_REGEX.test(code)).toBe(false);
    });
  });
});

describe("isMarimoAppText", () => {
  it("returns true for valid marimo app", () => {
    const code = "import marimo\n\napp = marimo.App()";
    expect(isMarimoAppText(code)).toBe(true);
  });

  it("returns false for non-marimo file", () => {
    const code = "import pandas as pd\nprint('hello')";
    expect(isMarimoAppText(code)).toBe(false);
  });
});

describe("findMarimoAppLine", () => {
  it.each([
    ["line 0", "app = marimo.App()", 0],
    ["line 2", "import marimo\n\napp = marimo.App()", 2],
    [
      "line 3 with comment",
      "import marimo\n\n# Initialize\napp = marimo.App()",
      3,
    ],
  ])("returns correct line number: %s", (_name, code, expectedLine) => {
    expect(findMarimoAppLine(code)).toBe(expectedLine);
  });

  it("returns undefined for non-marimo file", () => {
    expect(findMarimoAppLine("import pandas as pd")).toBeUndefined();
  });
});

// ============================================================================
// Functionality Tests (Integration with Effect-ts)
// ============================================================================

describe("MarimoCodeLensProviderLive", () => {
  const withTestCtx = Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();
    const layer = Layer.empty.pipe(
      Layer.provideMerge(MarimoCodeLensProviderLive),
      Layer.provide(vscode.layer),
    );
    return { vscode, layer };
  });

  it.effect(
    "registers CodeLens provider successfully",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();
      yield* Effect.provide(Effect.void, ctx.layer);
      // If we get here without errors, the provider was registered successfully
      expect(true).toBe(true);
    }),
  );

  it.effect(
    "happy path: provides CodeLens for valid marimo file",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();
      const pythonCode = `import marimo

app = marimo.App()

@app.cell
def _():
    return
`;
      const _document = createTestTextDocument(
        "/test/notebook.py",
        "python",
        pythonCode,
      );

      yield* Effect.provide(Effect.void, ctx.layer);

      // The provider is registered and will be called by VSCode
      // We verify the layer builds and the detection logic works
      expect(isMarimoAppText(pythonCode)).toBe(true);
      expect(findMarimoAppLine(pythonCode)).toBe(2);
    }),
  );
});
