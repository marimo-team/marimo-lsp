import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { TestLanguageClientLive } from "../../__mocks__/TestLanguageClient.ts";
import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import {
  createTestNotebookDocument,
  TestVsCodeLive,
} from "../../__mocks__/TestVsCode.ts";
import { ControllerRegistry } from "../ControllerRegistry.ts";
import { VsCode } from "../VsCode.ts";

const ControllerRegistryLive = Layer.empty.pipe(
  Layer.provideMerge(ControllerRegistry.Default),
  Layer.provide(TestLanguageClientLive),
  Layer.provideMerge(TestVsCodeLive),
  Layer.provide(TestPythonExtension.Default),
);

it.layer(ControllerRegistryLive)("ControllerRegistry", (it) => {
  it.effect(
    "should initialize",
    Effect.fnUntraced(function* () {
      const registry = yield* ControllerRegistry;
      expect(registry).toBeDefined();
    }),
  );

  it.effect(
    "should return None for active controller when no notebook is selected",
    Effect.fnUntraced(function* () {
      const code = yield* VsCode;
      const registry = yield* ControllerRegistry;

      const notebook = createTestNotebookDocument(
        code.Uri.file("/test/notebook_mo.py"),
      );

      const controller = yield* registry.getActiveController(notebook);
      expect(Option.isNone(controller)).toBe(true);
    }),
  );
});
