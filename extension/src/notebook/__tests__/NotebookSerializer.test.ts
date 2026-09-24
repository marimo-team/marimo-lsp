import * as NodeFs from "node:fs";

import * as Vitest from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";

import packageJson from "../../../package.json";
import { TestMarimoClientProcess } from "../../__mocks__/TestMarimoClient.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { makeTestMarimoClient } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import * as NotebookSerializer from "../../notebook/NotebookSerializer.ts";
import * as Constants from "../../platform/Constants.ts";

const liveLayer = Layer.empty.pipe(
  Layer.provideMerge(NotebookSerializer.layer),
  // These tests intentionally cover the cross-language serialization contract.
  Layer.provideMerge(TestMarimoClientProcess),
  Layer.provideMerge(Constants.defaultLayer),
);

Vitest.describe("when deserialization stalls", () => {
  const it = EffectTest.make(
    Layer.empty.pipe(
      Layer.provideMerge(NotebookSerializer.layer),
      Layer.provideMerge(makeTestMarimoClient({ send: () => Effect.never })),
      Layer.provideMerge(Constants.defaultLayer),
    ),
  );

  it.effect(
    "bounds a deserialize request that never completes",
    Effect.fn(function* () {
      const serializer = yield* NotebookSerializer.Service;
      const deserialize = yield* Effect.forkChild(
        serializer
          .deserializeEffect(new TextEncoder().encode("app = marimo.App()"))
          .pipe(Effect.exit),
      );
      yield* TestClock.adjust(Duration.seconds(120));
      const exit = yield* Fiber.join(deserialize);

      Vitest.assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      Vitest.assert(failure._tag === "Some");
      Vitest.assert(Cause.isTimeoutError(failure.value));
    }),
  );
});

Vitest.describe("when a registered deserializer stalls", () => {
  const it = EffectTest.make(
    Layer.empty.pipe(
      Layer.provideMerge(NotebookSerializer.layer),
      Layer.provideMerge(makeTestMarimoClient({ send: () => Effect.never })),
      Layer.provideMerge(Constants.defaultLayer),
      Layer.provideMerge(TestVsCode.layer),
    ),
  );

  it.effect(
    "registered serializer explains deserialize timeouts",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      yield* NotebookSerializer.Service;
      const registrations = yield* vscode.serializers;
      const registration = registrations[0];
      Vitest.assert.isDefined(registration);

      const deserialize = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            registration.serializer.deserializeNotebook(
              new TextEncoder().encode("app = marimo.App()"),
              {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
              },
            ),
          ),
        catch: (error) =>
          error instanceof NotebookSerializer.OperationError
            ? error
            : new NotebookSerializer.OperationError({
                message: String(error),
              }),
      }).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(Duration.seconds(120));
      const error = yield* Fiber.join(deserialize);

      Vitest.assert(error instanceof Error);
      Vitest.expect(error.message).toBe(
        "Timed out after 120 seconds while opening the notebook. See marimo logs for details.",
      );
    }),
  );
});

Vitest.describe("when registered source is not a marimo notebook", () => {
  const it = EffectTest.make(
    Layer.empty.pipe(
      Layer.provideMerge(NotebookSerializer.layer),
      Layer.provideMerge(
        makeTestMarimoClient({
          send: () =>
            Effect.succeed({
              kind: "convertible",
            }),
        }),
      ),
      Layer.provideMerge(Constants.defaultLayer),
      Layer.provideMerge(TestVsCode.layer),
    ),
  );

  it.effect(
    "registered serializer explains non-marimo source failures",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      yield* NotebookSerializer.Service;
      const registrations = yield* vscode.serializers;
      const registration = registrations[0];
      Vitest.assert.isDefined(registration);

      const error = yield* Effect.promise(async () => {
        try {
          await registration.serializer.deserializeNotebook(
            new TextEncoder().encode("print('hello')\n"),
            {
              isCancellationRequested: false,
              onCancellationRequested: () => ({ dispose() {} }),
            },
          );
          return undefined;
        } catch (error: unknown) {
          return error;
        }
      });

      Vitest.assert(error instanceof Error);
      Vitest.expect(error.message).toBe(
        "This is not a native marimo notebook and must be converted first.",
      );
    }),
  );
});

Vitest.layer(liveLayer)("NotebookSerializer", (it) => {
  Vitest.it("NOTEBOOK_TYPE matches package.json notebook type", () => {
    const notebookConfig = packageJson.contributes.notebooks.find(
      (nb) => nb.type === NOTEBOOK_TYPE,
    );
    Vitest.expect(notebookConfig).toBeDefined();
    Vitest.assert.strictEqual(notebookConfig?.type, NOTEBOOK_TYPE);
  });

  it.effect(
    "rejects invalid owned metadata instead of serializing defaults",
    Effect.fn(function* () {
      const { LanguageId } = yield* Constants.Service;
      const serializer = yield* NotebookSerializer.Service;
      const invalidCell = yield* Effect.result(
        serializer.serializeEffect({
          cells: [
            {
              kind: 2,
              value: "x = 1",
              languageId: LanguageId.Python,
              metadata: { marimo: { misspelled: true } },
            },
          ],
        }),
      );
      const invalidNotebook = yield* Effect.result(
        serializer.serializeEffect({
          cells: [],
          metadata: { marimo: { misspelled: true } },
        }),
      );

      Vitest.expect(Result.isFailure(invalidCell)).toBe(true);
      Vitest.expect(Result.isFailure(invalidNotebook)).toBe(true);
    }),
  );

  it.effect(
    "serializes notebook cells to marimo format",
    Effect.fn(function* () {
      const { LanguageId } = yield* Constants.Service;
      const serializer = yield* NotebookSerializer.Service;
      const bytes = yield* serializer.serializeEffect({
        cells: [
          {
            kind: 2,
            value: "import marimo as mo",
            languageId: LanguageId.Python,
          },
          {
            kind: 2,
            value: "x = 1",
            languageId: LanguageId.Python,
          },
        ],
      });
      const serializedSource = new TextDecoder().decode(bytes).trim();
      Vitest.expect(removeGeneratedWith(serializedSource))
        .toMatchInlineSnapshot(`
          "import marimo

          __generated_with = ""
          app = marimo.App()


          @app.cell
          def _():
              import marimo as mo

              return


          @app.cell
          def _():
              x = 1
              return


          if __name__ == "__main__":
              app.run()"
        `);
    }),
  );

  it.effect(
    "serializes markdown notebook cells to marimo format",
    Effect.fn(function* () {
      const { LanguageId } = yield* Constants.Service;
      const serializer = yield* NotebookSerializer.Service;
      const bytes = yield* serializer.serializeEffect({
        cells: [
          {
            kind: 2,
            value: "import marimo as mo",
            languageId: LanguageId.Python,
          },
          {
            kind: 1,
            value: "# single line markdown",
            languageId: LanguageId.Markdown,
          },
          {
            kind: 1,
            value: "- multiline\n-markdown",
            languageId: LanguageId.Markdown,
          },
        ],
      });
      const serializedSource = new TextDecoder().decode(bytes).trim();
      Vitest.expect(removeGeneratedWith(serializedSource))
        .toMatchInlineSnapshot(`
          "import marimo

          __generated_with = ""
          app = marimo.App()


          @app.cell
          def _():
              import marimo as mo

              return (mo,)


          @app.cell(hide_code=True)
          def _(mo):
              mo.md(r"""
              # single line markdown
              """)
              return


          @app.cell(hide_code=True)
          def _(mo):
              mo.md(r"""
              - multiline
              -markdown
              """)
              return


          if __name__ == "__main__":
              app.run()"
        `);
    }),
  );

  it.effect.each([
    { name: "empty", metadata: {} },
    { name: "foreign-only", metadata: { foreign: { value: true } } },
    { name: "empty marimo", metadata: { marimo: {} } },
    { name: "empty options", metadata: { marimo: { options: {} } } },
  ])("uses markdown defaults for a $name metadata envelope", ({ metadata }) =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants.Service;
      const serializer = yield* NotebookSerializer.Service;
      const bytes = yield* serializer.serializeEffect({
        cells: [
          {
            kind: 1,
            value: "# markdown",
            languageId: LanguageId.Markdown,
            metadata,
          },
        ],
      });

      Vitest.expect(new TextDecoder().decode(bytes)).toContain(
        "@app.cell(hide_code=True)",
      );
    }),
  );

  it.effect(
    "preserves an explicit hide_code=false for markdown",
    Effect.fn(function* () {
      const { LanguageId } = yield* Constants.Service;
      const serializer = yield* NotebookSerializer.Service;
      const bytes = yield* serializer.serializeEffect({
        cells: [
          {
            kind: 1,
            value: "# markdown",
            languageId: LanguageId.Markdown,
            metadata: {
              marimo: { options: { hide_code: false } },
            },
          },
        ],
      });

      Vitest.expect(new TextDecoder().decode(bytes)).not.toContain(
        "@app.cell(hide_code=True)",
      );
    }),
  );

  it.effect(
    "rejects a present null notebook metadata namespace",
    Effect.fn(function* () {
      const serializer = yield* NotebookSerializer.Service;
      const result = yield* Effect.result(
        serializer.serializeEffect({
          cells: [],
          metadata: { marimo: null },
        }),
      );

      Vitest.expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect(
    "returns a typed source error for non-marimo Python",
    Effect.fn(function* () {
      const serializer = yield* NotebookSerializer.Service;
      const result = yield* Effect.result(
        serializer.deserializeEffect(
          new TextEncoder().encode("print('hello')\n"),
        ),
      );

      Vitest.assert(Result.isFailure(result));
      Vitest.assert(
        result.failure instanceof NotebookSerializer.NotebookSourceError,
      );
      Vitest.expect(result.failure.failure).toEqual({
        kind: "convertible",
      });
    }),
  );

  it.effect(
    "deserializes mo.md() without f-strings to markdown cells",
    Effect.fn(function* () {
      const { LanguageId } = yield* Constants.Service;
      const serializer = yield* NotebookSerializer.Service;
      const source = `import marimo

__generated_with = "0.9.0"
app = marimo.App()


@app.cell
def _():
    import marimo as mo
    return


@app.cell
def _(mo):
    mo.md(r"""
    # Hello World

    This is a markdown cell.
    """)
    return


@app.cell
def _(mo):
    mo.md('''Single quotes''')
    return


if __name__ == "__main__":
    app.run()`;

      const bytes = new TextEncoder().encode(source);
      const notebook = yield* serializer.deserializeEffect(bytes);

      // First cell should be Python
      Vitest.expect(notebook.cells[0].kind).toBe(2);
      Vitest.expect(notebook.cells[0].languageId).toBe(LanguageId.Python);
      Vitest.expect(notebook.cells[0].value).toBe("import marimo as mo");

      // Second cell should be Markdown (not Python)
      Vitest.expect(notebook.cells[1].kind).toBe(1);
      Vitest.expect(notebook.cells[1].languageId).toBe(LanguageId.Markdown);
      Vitest.expect(notebook.cells[1].value).toBe(
        "# Hello World\n\nThis is a markdown cell.",
      );

      // Third cell should also be Markdown
      Vitest.expect(notebook.cells[2].kind).toBe(1);
      Vitest.expect(notebook.cells[2].languageId).toBe(LanguageId.Markdown);
      Vitest.expect(notebook.cells[2].value).toBe("Single quotes");
    }),
  );

  it.effect(
    "keeps mo.md() with f-strings as Python cells",
    Effect.fn(function* () {
      const { LanguageId } = yield* Constants.Service;
      const serializer = yield* NotebookSerializer.Service;
      const source = `import marimo

__generated_with = "0.9.0"
app = marimo.App()


@app.cell
def _():
    import marimo as mo
    name = "World"
    return


@app.cell
def _(mo, name):
    mo.md(f"""
    # Hello {name}

    This uses an f-string.
    """)
    return


if __name__ == "__main__":
    app.run()`;

      const bytes = new TextEncoder().encode(source);
      const notebook = yield* serializer.deserializeEffect(bytes);

      // First cell should be Python
      Vitest.expect(notebook.cells[0].kind).toBe(2);
      Vitest.expect(notebook.cells[0].languageId).toBe(LanguageId.Python);

      // Second cell should remain Python (because it's an f-string)
      Vitest.expect(notebook.cells[1].kind).toBe(2);
      Vitest.expect(notebook.cells[1].languageId).toBe(LanguageId.Python);
      Vitest.expect(notebook.cells[1].value).toContain("mo.md(f");
      Vitest.expect(notebook.cells[1].value).toContain("{name}");
    }),
  );

  it.effect(
    "round-trip markdown cells maintain mo.md() format",
    Effect.fn(function* () {
      const { LanguageId } = yield* Constants.Service;
      const serializer = yield* NotebookSerializer.Service;
      const source = `import marimo

__generated_with = "0.9.0"
app = marimo.App()


@app.cell
def _():
    import marimo as mo

    return (mo,)


@app.cell
def _(mo):
    mo.md(r"""
    # Markdown Title

    Some **bold** text.
    """)
    return


if __name__ == "__main__":
    app.run()`;

      const bytes = new TextEncoder().encode(source);
      const notebook = yield* serializer.deserializeEffect(bytes);

      // Should be deserialized as markdown
      Vitest.expect(notebook.cells[1].kind).toBe(1);
      Vitest.expect(notebook.cells[1].languageId).toBe(LanguageId.Markdown);

      // Re-serialize and check it goes back to mo.md()
      const serialized = yield* serializer.serializeEffect(notebook);
      const serializedSource = new TextDecoder().decode(serialized).trim();

      Vitest.expect(removeGeneratedWith(serializedSource)).toBe(
        removeGeneratedWith(source.trim()),
      );
    }),
  );

  it.effect.each([
    ["simple notebook", "simple.txt"],
    ["notebook with named cells", "with_names.txt"],
    ["notebook with multiline cells", "multiline.txt"],
    ["notebook with cell options", "with_options.txt"],
    ["notebook with setup cell", "with_setup.txt"],
    ["notebook with ellipsis", "with_ellipsis.txt"],
  ] as const)("identity: %s", ([_, filename]) => {
    return Effect.gen(function* () {
      const serializer = yield* NotebookSerializer.Service;
      const source = yield* Effect.tryPromise(() =>
        NodeFs.promises.readFile(
          new URL(`../../__mocks__/notebooks/${filename}`, import.meta.url),
          "utf-8",
        ),
      );
      const bytes = new TextEncoder().encode(source);

      const notebook = yield* serializer.deserializeEffect(bytes);
      const serialized = yield* serializer.serializeEffect(notebook);
      const serializedSource = new TextDecoder().decode(serialized).trim();
      const sourceSource = source.trim();

      Vitest.expect(
        normalizeLineEndings(removeGeneratedWith(serializedSource)),
      ).toBe(normalizeLineEndings(removeGeneratedWith(sourceSource)));
    });
  });
});

function removeGeneratedWith(source: string): string {
  return source.replace(/__generated_with = ".*"/, '__generated_with = ""');
}

function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, "\n");
}
