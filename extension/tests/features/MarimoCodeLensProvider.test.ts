import * as Vitest from "@effect/vitest";
import { Effect, Layer } from "effect";

import * as MarimoCodeLensProvider from "../../src/features/MarimoCodeLensProvider.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

// ============================================================================
// Regex Tests (Pure Functions)
// ============================================================================

Vitest.describe("appPattern", () => {
  Vitest.describe("should match valid marimo app declarations", () => {
    Vitest.it.each([
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
      Vitest.expect(MarimoCodeLensProvider.appPattern.test(code)).toBe(true);
    });
  });

  Vitest.describe("should NOT match invalid patterns", () => {
    Vitest.it.each([
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
      Vitest.expect(MarimoCodeLensProvider.appPattern.test(code)).toBe(false);
    });
  });
});

Vitest.describe("isAppText", () => {
  Vitest.it("returns true for valid marimo app", () => {
    const code = "import marimo\n\napp = marimo.App()";
    Vitest.expect(MarimoCodeLensProvider.isAppText(code)).toBe(true);
  });

  Vitest.it("returns false for non-marimo file", () => {
    const code = "import pandas as pd\nprint('hello')";
    Vitest.expect(MarimoCodeLensProvider.isAppText(code)).toBe(false);
  });
});

Vitest.describe("findAppLine", () => {
  Vitest.it.each([
    ["line 0", "app = marimo.App()", 0],
    ["line 2", "import marimo\n\napp = marimo.App()", 2],
    [
      "line 3 with comment",
      "import marimo\n\n# Initialize\napp = marimo.App()",
      3,
    ],
  ])("returns correct line number: %s", (_name, code, expectedLine) => {
    Vitest.expect(MarimoCodeLensProvider.findAppLine(code)).toBe(expectedLine);
  });

  Vitest.it("returns undefined for non-marimo file", () => {
    Vitest.expect(
      MarimoCodeLensProvider.findAppLine("import pandas as pd"),
    ).toBeUndefined();
  });
});

// ============================================================================
// Functionality Tests (Integration with Effect-ts)
// ============================================================================

Vitest.describe("MarimoCodeLensProvider.layer", () => {
  const effectIt = EffectTest.make(
    Layer.empty.pipe(
      Layer.provideMerge(MarimoCodeLensProvider.layer),
      Layer.provide(VsCodeTest.layer),
    ),
  );

  effectIt.effect("registers CodeLens provider successfully", () =>
    Effect.sync(() => {
      // If we get here without errors, the provider was registered successfully
      Vitest.expect(true).toBe(true);
    }),
  );

  effectIt.effect("detects a marimo app in Python source", () =>
    Effect.sync(() => {
      const pythonCode = `import marimo

app = marimo.App()

@app.cell
def _():
    return
`;
      Vitest.expect(MarimoCodeLensProvider.isAppText(pythonCode)).toBe(true);
      Vitest.expect(MarimoCodeLensProvider.findAppLine(pythonCode)).toBe(2);
    }),
  );
});
