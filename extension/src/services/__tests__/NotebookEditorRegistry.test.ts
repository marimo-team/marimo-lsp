import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { NotebookEditorRegistry } from "../NotebookEditorRegistry.ts";

const NotebookEditorRegistryLive = Layer.empty.pipe(
  Layer.provideMerge(NotebookEditorRegistry.Default),
  Layer.provide(TestVsCode.Default),
);

it.layer(NotebookEditorRegistryLive)("NotebookEditorRegistry", (it) => {
  it.effect(
    "should build",
    Effect.fnUntraced(function* () {
      const api = yield* NotebookEditorRegistry;
      expect(api).toBeDefined();
    }),
  );
});
