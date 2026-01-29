import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestSentryLive } from "../../__mocks__/TestSentry.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { Api } from "../Api.ts";
import { ControllerRegistry } from "../ControllerRegistry.ts";
import { LanguageClient } from "../LanguageClient.ts";
import { VsCode } from "../VsCode.ts";

const withTestCtx = Effect.fnUntraced(function* (
  options: Parameters<(typeof TestVsCode)["make"]>[0] = {},
) {
  const testVsCode = yield* TestVsCode.make(options);
  return {
    vscode: testVsCode,
    layer: Layer.empty.pipe(
      Layer.merge(Api.Default),
      Layer.provideMerge(ControllerRegistry.Default),
      Layer.provide(
        Layer.succeed(
          LanguageClient,
          LanguageClient.make({
            channel: { name: "marimo-lsp-test", show() {} },
            restart: Effect.void,
            executeCommand() {
              return Effect.die("not implemented");
            },
            streamOf() {
              return Effect.die("not implemented");
            },
          }),
        ),
      ),
      Layer.provide(TestTelemetryLive),
      Layer.provide(TestSentryLive),
      Layer.provide(TestPythonExtension.Default),
      Layer.provideMerge(testVsCode.layer),
    ),
  };
});

describe("Api", () => {
  it.scoped(
    "has experimental.kernels namespace",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();

      const api = yield* Api.pipe(Effect.provide(ctx.layer));

      expect(api).toBeDefined();
      expect(api.experimental).toBeDefined();
      expect(api.experimental.kernels).toBeDefined();
      expect(typeof api.experimental.kernels.getKernel).toBe("function");
    }),
  );

  it.scoped(
    "getKernel returns undefined for non-existent notebook",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();

      const kernel = yield* Effect.gen(function* () {
        const api = yield* Api;
        const code = yield* VsCode;
        const fakeUri = yield* code.utils.parseUri(
          "file:///non-existent-notebook.py",
        );

        return yield* Effect.promise(() =>
          api.experimental.kernels.getKernel(fakeUri),
        );
      }).pipe(Effect.provide(ctx.layer));

      expect(kernel).toBeUndefined();
    }),
  );

  it.scoped(
    "getKernel returns undefined when notebook exists but no controller",
    Effect.fnUntraced(function* () {
      const notebookDoc = createTestNotebookDocument(
        "file:///test/notebook_mo.py",
        {
          data: {
            cells: [
              {
                kind: 1,
                value: "x = 42",
                languageId: "python",
                metadata: { stableId: "cell-1" },
              },
            ],
          },
        },
      );

      const ctx = yield* withTestCtx({ initialDocuments: [notebookDoc] });

      const kernel = yield* Effect.gen(function* () {
        const api = yield* Api;
        const code = yield* VsCode;
        const uri = yield* code.utils.parseUri("file:///test/notebook_mo.py");
        return yield* Effect.promise(() =>
          api.experimental.kernels.getKernel(uri),
        );
      }).pipe(Effect.provide(ctx.layer));

      expect(kernel).toBeUndefined();
    }),
  );
});
