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
  Layer.provide(TestLanguageClientLive),
);

describe("NotebookSerializer", () => {
  it("NOTEBOOK_TYPE matches package.json notebook type", () => {
    const notebookConfig = packageJson.contributes.notebooks.find(
      (nb) => nb.type === NOTEBOOK_TYPE,
    );
    expect(notebookConfig).toBeDefined();
    expect(notebookConfig?.type).toBe(NOTEBOOK_TYPE);
  });

  it.scoped("serializes notebook cells to marimo format", () =>
    Effect.gen(function* () {
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
      expect(new TextDecoder().decode(bytes)).toMatchInlineSnapshot(`
      "import marimo

      __generated_with = "0.16.2"
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
          app.run()
      "
    `);
    }).pipe(Effect.provide(NotebookSerializerLive)),
  );
});
