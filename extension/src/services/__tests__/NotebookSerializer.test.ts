import * as NodeFs from "node:fs";
import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import packageJson from "../../../package.json";
import { TestLanguageClientLive } from "../../__mocks__/TestLanguageClient.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { NotebookSerializer } from "../../services/NotebookSerializer.ts";

const NotebookSerializerLive = Layer.empty.pipe(
  Layer.provideMerge(NotebookSerializer.Default),
  Layer.provideMerge(TestLanguageClientLive),
);

it.layer(NotebookSerializerLive)("NotebookSerializer", (it) => {
  it("NOTEBOOK_TYPE matches package.json notebook type", () => {
    const notebookConfig = packageJson.contributes.notebooks.find(
      (nb) => nb.type === NOTEBOOK_TYPE,
    );
    expect(notebookConfig).toBeDefined();
    assert.strictEqual(notebookConfig?.type, NOTEBOOK_TYPE);
  });

  it.effect(
    "serializes notebook cells to marimo format",
    Effect.fnUntraced(function* () {
      const serializer = yield* NotebookSerializer;
      const bytes = yield* serializer.serializeEffect({
        cells: [
          {
            kind: 2,
            value: "import marimo as mo",
            languageId: "python",
          },
          {
            kind: 2,
            value: "x = 1",
            languageId: "python",
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
    Effect.fnUntraced(function* () {
      const serializer = yield* NotebookSerializer;
      const bytes = yield* serializer.serializeEffect({
        cells: [
          {
            kind: 2,
            value: "import marimo as mo",
            languageId: "python",
          },
          {
            kind: 1,
            value: "# single line markdown",
            languageId: "markdown",
          },
          {
            kind: 1,
            value: "- multiline\n-markdown",
            languageId: "markdown",
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


        @app.cell
        def _(mo):
            mo.md(r"""
            # single line markdown
            """)
            return


        @app.cell
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

  it.effect(
    "deserializes mo.md() without f-strings to markdown cells",
    Effect.fnUntraced(function* () {
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
      expect(notebook.cells[0].languageId).toBe("python");
      expect(notebook.cells[0].value).toBe("import marimo as mo");

      // Second cell should be Markdown (not Python)
      expect(notebook.cells[1].kind).toBe(1);
      expect(notebook.cells[1].languageId).toBe("markdown");
      expect(notebook.cells[1].value).toBe(
        "# Hello World\n\nThis is a markdown cell.",
      );

      // Third cell should also be Markdown
      expect(notebook.cells[2].kind).toBe(1);
      expect(notebook.cells[2].languageId).toBe("markdown");
      expect(notebook.cells[2].value).toBe("Single quotes");
    }),
  );

  it.effect(
    "keeps mo.md() with f-strings as Python cells",
    Effect.fnUntraced(function* () {
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
      expect(notebook.cells[0].languageId).toBe("python");

      // Second cell should remain Python (because it's an f-string)
      expect(notebook.cells[1].kind).toBe(2);
      expect(notebook.cells[1].languageId).toBe("python");
      expect(notebook.cells[1].value).toContain("mo.md(f");
      expect(notebook.cells[1].value).toContain("{name}");
    }),
  );

  it.effect(
    "round-trip markdown cells maintain mo.md() format",
    Effect.fnUntraced(function* () {
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
      expect(notebook.cells[1].languageId).toBe("markdown");

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

      expect(removeGeneratedWith(serializedSource)).toBe(
        removeGeneratedWith(sourceSource),
      );
    });
  });
});

function removeGeneratedWith(source: string): string {
  return source.replace(/__generated_with = ".*"/, '__generated_with = ""');
}
