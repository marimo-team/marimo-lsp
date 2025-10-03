import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { LanguageClient } from "../services/LanguageClient.ts";
import { NotebookSerializer } from "../services/NotebookSerializer.ts";
import { TestLanguageClientLive } from "./TestLanguageClient.ts";

const NotebookSerializerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const client = yield* LanguageClient;
    // start the language server
    yield* client.manage();
  }),
).pipe(
  Layer.provideMerge(NotebookSerializer.DefaultWithoutDependencies),
  Layer.provide(TestLanguageClientLive),
);

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
