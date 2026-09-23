import { describe, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { TestExtensionContextLive } from "../../__mocks__/TestExtensionContext.ts";
import * as TestPythonExtension from "../../__mocks__/TestPythonExtension.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import * as Api from "../Api.ts";
import * as VsCode from "../VsCode.ts";

const it = EffectTest.make(
  Layer.empty.pipe(
    Layer.merge(Api.layer),
    Layer.provide(makeTestNotebookRuntime()),
    Layer.provide(TestTelemetryLive),
    Layer.provide(TestPythonExtension.layer),
    Layer.provide(TestExtensionContextLive),
    Layer.provideMerge(TestVsCode.layer),
  ),
);

describe("Api", () => {
  it.effect(
    "has experimental.kernels namespace",
    Effect.fn(function* () {
      const api = yield* Api.Service;

      expect(api).toBeDefined();
      expect(api.experimental).toBeDefined();
      expect(api.experimental.kernels).toBeDefined();
      expect(typeof api.experimental.kernels.getKernel).toBe("function");
    }),
  );

  it.effect(
    "getKernel returns undefined for non-existent notebook",
    Effect.fn(function* () {
      const api = yield* Api.Service;
      const code = yield* VsCode.Service;
      const fakeUri = yield* Effect.fromResult(
        code.utils.parseUri("file:///non-existent-notebook.py"),
      );
      const kernel = yield* Effect.promise(() =>
        api.experimental.kernels.getKernel(fakeUri),
      );

      expect(kernel).toBeUndefined();
    }),
  );

  it.effect(
    "getKernel returns undefined when notebook exists but no controller",
    Effect.fn(function* () {
      const notebookDoc = TestVsCode.createTestNotebookDocument(
        "file:///test/notebook_mo.py",
        {
          data: {
            cells: [
              {
                kind: 1,
                value: "x = 42",
                languageId: "python",
                metadata: MarimoNotebookCell.createMetadata({
                  marimoRuntime: { stableId: "cell-1" },
                }),
              },
            ],
          },
        },
      );

      const vscode = yield* TestVsCode.Service;
      yield* vscode.openNotebook(notebookDoc);
      const api = yield* Api.Service;
      const code = yield* VsCode.Service;
      const uri = yield* Effect.fromResult(
        code.utils.parseUri("file:///test/notebook_mo.py"),
      );
      const kernel = yield* Effect.promise(() =>
        api.experimental.kernels.getKernel(uri),
      );

      expect(kernel).toBeUndefined();
    }),
  );
});
