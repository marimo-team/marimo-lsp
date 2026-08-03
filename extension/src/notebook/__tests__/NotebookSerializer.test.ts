import * as NodeFs from "node:fs";

import { assert, expect, it } from "@effect/vitest";
import {
  Cause,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  HashSet,
  Layer,
  Ref,
  TestClock,
} from "effect";

import packageJson from "../../../package.json";
import { TestMarimoClientLive } from "../../__mocks__/TestMarimoClient.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { makeTestMarimoClient } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import {
  NotebookSerializer,
  NotebookSourceError,
} from "../../notebook/NotebookSerializer.ts";
import { Constants } from "../../platform/Constants.ts";

const NotebookSerializerLive = Layer.empty.pipe(
  Layer.provideMerge(NotebookSerializer.Default),
  Layer.provideMerge(TestMarimoClientLive),
  Layer.provideMerge(Constants.Default),
);

it.scoped(
  "bounds a deserialize request that never completes",
  Effect.fn(function* () {
    const layer = Layer.empty.pipe(
      Layer.provideMerge(NotebookSerializer.Default),
      Layer.provideMerge(makeTestMarimoClient({ execute: () => Effect.never })),
      Layer.provideMerge(Constants.Default),
    );

    const exit = yield* Effect.gen(function* () {
      const serializer = yield* NotebookSerializer;
      const deserialize = yield* Effect.fork(
        serializer
          .deserializeEffect(new TextEncoder().encode("app = marimo.App()"))
          .pipe(Effect.exit),
      );
      yield* TestClock.adjust(Duration.seconds(120));
      return yield* Fiber.join(deserialize);
    }).pipe(Effect.provide(layer));

    assert(Exit.isFailure(exit));
    const failure = Cause.failureOption(exit.cause);
    assert(failure._tag === "Some");
    assert(Cause.isTimeoutException(failure.value));
  }),
);

it.scoped(
  "registered serializer explains deserialize timeouts",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make();
    const layer = Layer.empty.pipe(
      Layer.provideMerge(NotebookSerializer.Default),
      Layer.provideMerge(makeTestMarimoClient({ execute: () => Effect.never })),
      Layer.provideMerge(Constants.Default),
      Layer.provideMerge(vscode.layer),
    );

    yield* Effect.gen(function* () {
      yield* NotebookSerializer;
      const registrations = HashSet.toValues(
        yield* Ref.get(vscode.serializers),
      );
      const registration = registrations[0];
      assert.isDefined(registration);

      const pending = registration.serializer.deserializeNotebook(
        new TextEncoder().encode("app = marimo.App()"),
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} }),
        },
      );
      const settled = Promise.resolve(pending).then(
        () => undefined,
        (error: unknown) => error,
      );
      yield* Effect.yieldNow();
      yield* TestClock.adjust(Duration.seconds(120));
      const error = yield* Effect.promise(() => settled);

      assert(error instanceof Error);
      expect(error.message).toBe(
        "Timed out after 120 seconds while opening the notebook. See marimo logs for details.",
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.scoped(
  "registered serializer explains non-marimo source failures",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make();
    const layer = Layer.empty.pipe(
      Layer.provideMerge(NotebookSerializer.Default),
      Layer.provideMerge(
        makeTestMarimoClient({
          execute: () =>
            Effect.succeed({
              kind: "convertible",
            }),
        }),
      ),
      Layer.provideMerge(Constants.Default),
      Layer.provideMerge(vscode.layer),
    );

    yield* Effect.gen(function* () {
      yield* NotebookSerializer;
      const registrations = HashSet.toValues(
        yield* Ref.get(vscode.serializers),
      );
      const registration = registrations[0];
      assert.isDefined(registration);

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

      assert(error instanceof Error);
      expect(error.message).toBe(
        "This is not a native marimo notebook and must be converted first.",
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.layer(NotebookSerializerLive, { timeout: 30_000 })(
  "NotebookSerializer",
  (it) => {
    it("NOTEBOOK_TYPE matches package.json notebook type", () => {
      const notebookConfig = packageJson.contributes.notebooks.find(
        (nb) => nb.type === NOTEBOOK_TYPE,
      );
      expect(notebookConfig).toBeDefined();
      assert.strictEqual(notebookConfig?.type, NOTEBOOK_TYPE);
    });

    it.effect(
      "rejects invalid owned metadata instead of serializing defaults",
      Effect.fn(function* () {
        const { LanguageId } = yield* Constants;
        const serializer = yield* NotebookSerializer;
        const invalidCell = yield* Effect.either(
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
        const invalidNotebook = yield* Effect.either(
          serializer.serializeEffect({
            cells: [],
            metadata: { marimo: { misspelled: true } },
          }),
        );

        expect(Either.isLeft(invalidCell)).toBe(true);
        expect(Either.isLeft(invalidNotebook)).toBe(true);
      }),
    );

    it.effect(
      "serializes notebook cells to marimo format",
      Effect.fn(function* () {
        const { LanguageId } = yield* Constants;
        const serializer = yield* NotebookSerializer;
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
        expect(removeGeneratedWith(serializedSource)).toMatchInlineSnapshot(`
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
        const { LanguageId } = yield* Constants;
        const serializer = yield* NotebookSerializer;
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
        expect(removeGeneratedWith(serializedSource)).toMatchInlineSnapshot(`
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
    ])("uses markdown defaults for a $name metadata envelope", ({ metadata }) =>
      Effect.gen(function* () {
        const { LanguageId } = yield* Constants;
        const serializer = yield* NotebookSerializer;
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

        expect(new TextDecoder().decode(bytes)).toContain(
          "@app.cell(hide_code=True)",
        );
      }),
    );

    it.effect(
      "rejects a present null notebook metadata namespace",
      Effect.fn(function* () {
        const serializer = yield* NotebookSerializer;
        const result = yield* Effect.either(
          serializer.serializeEffect({
            cells: [],
            metadata: { marimo: null },
          }),
        );

        expect(Either.isLeft(result)).toBe(true);
      }),
    );

    it.effect(
      "returns a typed source error for non-marimo Python",
      Effect.fn(function* () {
        const serializer = yield* NotebookSerializer;
        const result = yield* Effect.either(
          serializer.deserializeEffect(
            new TextEncoder().encode("print('hello')\n"),
          ),
        );

        assert(Either.isLeft(result));
        assert(result.left instanceof NotebookSourceError);
        expect(result.left.failure).toEqual({
          kind: "convertible",
        });
      }),
    );

    it.effect(
      "deserializes mo.md() without f-strings to markdown cells",
      Effect.fn(function* () {
        const { LanguageId } = yield* Constants;
        const serializer = yield* NotebookSerializer;
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
        expect(notebook.cells[0].kind).toBe(2);
        expect(notebook.cells[0].languageId).toBe(LanguageId.Python);
        expect(notebook.cells[0].value).toBe("import marimo as mo");

        // Second cell should be Markdown (not Python)
        expect(notebook.cells[1].kind).toBe(1);
        expect(notebook.cells[1].languageId).toBe(LanguageId.Markdown);
        expect(notebook.cells[1].value).toBe(
          "# Hello World\n\nThis is a markdown cell.",
        );

        // Third cell should also be Markdown
        expect(notebook.cells[2].kind).toBe(1);
        expect(notebook.cells[2].languageId).toBe(LanguageId.Markdown);
        expect(notebook.cells[2].value).toBe("Single quotes");
      }),
    );

    it.effect(
      "keeps mo.md() with f-strings as Python cells",
      Effect.fn(function* () {
        const { LanguageId } = yield* Constants;
        const serializer = yield* NotebookSerializer;
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
        expect(notebook.cells[0].kind).toBe(2);
        expect(notebook.cells[0].languageId).toBe(LanguageId.Python);

        // Second cell should remain Python (because it's an f-string)
        expect(notebook.cells[1].kind).toBe(2);
        expect(notebook.cells[1].languageId).toBe(LanguageId.Python);
        expect(notebook.cells[1].value).toContain("mo.md(f");
        expect(notebook.cells[1].value).toContain("{name}");
      }),
    );

    it.effect(
      "round-trip markdown cells maintain mo.md() format",
      Effect.fn(function* () {
        const { LanguageId } = yield* Constants;
        const serializer = yield* NotebookSerializer;
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
        expect(notebook.cells[1].kind).toBe(1);
        expect(notebook.cells[1].languageId).toBe(LanguageId.Markdown);

        // Re-serialize and check it goes back to mo.md()
        const serialized = yield* serializer.serializeEffect(notebook);
        const serializedSource = new TextDecoder().decode(serialized).trim();

        expect(removeGeneratedWith(serializedSource)).toBe(
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
        const serializer = yield* NotebookSerializer;
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

        expect(
          normalizeLineEndings(removeGeneratedWith(serializedSource)),
        ).toBe(normalizeLineEndings(removeGeneratedWith(sourceSource)));
      });
    });
  },
);

function removeGeneratedWith(source: string): string {
  return source.replace(/__generated_with = ".*"/, '__generated_with = ""');
}

function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, "\n");
}
