import * as Vitest from "@effect/vitest";
import { Effect, Layer } from "effect";

import * as ExtensionContextTest from "../../__tests__/fake/ExtensionContext.ts";
import * as NotebookRuntimeTest from "../../__tests__/fake/NotebookRuntime.ts";
import * as PythonExtensionTest from "../../__tests__/fake/PythonExtension.ts";
import * as TelemetryTest from "../../__tests__/fake/Telemetry.ts";
import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import * as Api from "../Api.ts";
import * as VsCode from "../VsCode.ts";

const it = EffectTest.make(
  Layer.empty.pipe(
    Layer.merge(Api.layer),
    Layer.provide(NotebookRuntimeTest.layerWith()),
    Layer.provide(TelemetryTest.layer),
    Layer.provide(PythonExtensionTest.layer),
    Layer.provide(ExtensionContextTest.layer),
    Layer.provideMerge(VsCodeTest.layer),
  ),
);

Vitest.describe("Api", () => {
  it.effect(
    "has experimental.kernels namespace",
    Effect.fn(function* () {
      const api = yield* Api.Service;

      Vitest.expect(api).toBeDefined();
      Vitest.expect(api.experimental).toBeDefined();
      Vitest.expect(api.experimental.kernels).toBeDefined();
      Vitest.expect(typeof api.experimental.kernels.getKernel).toBe("function");
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

      Vitest.expect(kernel).toBeUndefined();
    }),
  );

  it.effect(
    "getKernel returns undefined when notebook exists but no controller",
    Effect.fn(function* () {
      const notebookDoc = VsCodeTest.createTestNotebookDocument(
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

      const vscode = yield* VsCodeTest.Service;
      yield* vscode.openNotebook(notebookDoc);
      const api = yield* Api.Service;
      const code = yield* VsCode.Service;
      const uri = yield* Effect.fromResult(
        code.utils.parseUri("file:///test/notebook_mo.py"),
      );
      const kernel = yield* Effect.promise(() =>
        api.experimental.kernels.getKernel(uri),
      );

      Vitest.expect(kernel).toBeUndefined();
    }),
  );
});
