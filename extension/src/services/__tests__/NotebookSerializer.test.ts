import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import packageJson from "../../../package.json";
import { TestLanguageClientLive } from "../../__mocks__/TestLanguageClient.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { LanguageClient } from "../../services/LanguageClient.ts";
import { NotebookSerializer } from "../../services/NotebookSerializer.ts";

const NotebookSerializerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const client = yield* LanguageClient;
    // start the language server
    yield* client.manage();
  }),
).pipe(
  Layer.provideMerge(NotebookSerializer.Default),
  Layer.provideMerge(TestLanguageClientLive),
);

it.layer(NotebookSerializerLive)("NotebookSerializer", (it) => {
  it("NOTEBOOK_TYPE matches package.json notebook type", () => {
    const notebookConfig = packageJson.contributes.notebooks.find(
      (nb) => nb.type === NOTEBOOK_TYPE,
    );
    expect(notebookConfig).toBeDefined();
    expect(notebookConfig?.type).toBe(NOTEBOOK_TYPE);
  });

  it.effect(
    "provides same notebookType as in package.json",
    Effect.fnUntraced(function* () {
      const serializer = yield* NotebookSerializer;
      expect(serializer.notebookType).toBe(NOTEBOOK_TYPE);
    }),
  );

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

  it.effect.each([
    ["simple notebook", "simple.txt"],
    ["notebook with named cells", "with_names.txt"],
    ["notebook with multiline cells", "multiline.txt"],
    ["notebook with cell options", "with_options.txt"],
    ["notebook with setup cell", "with_setup.txt"],
  ] as const)("identity: %s", ([_name, filename]) => {
    return Effect.gen(function* () {
      const serializer = yield* NotebookSerializer;
      const source = yield* Effect.tryPromise(() =>
        readFile(
          join(__dirname, `../../__mocks__/notebooks/${filename}`),
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
