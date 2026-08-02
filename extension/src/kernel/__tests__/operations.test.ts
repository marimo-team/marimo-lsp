import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";

import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { Config } from "../../config/Config.ts";
import { PythonEnvInvalidation } from "../../python/PythonEnvInvalidation.ts";
import { Uv } from "../../python/Uv.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import type { NotificationOf } from "../../types.ts";
import type { NotebookController } from "../NotebookRuntime.ts";
import { handleMissingPackageAlert } from "../operations.ts";

const alert: NotificationOf<"missing-package-alert"> = {
  op: "missing-package-alert",
  packages: ["polars"],
  isolated: true,
};

// A sandbox-style controller (no `executable`), so the alert goes down the
// script-install path and reaches the prompt without touching the filesystem.
const controller: NotebookController = {
  id: "test-controller",
  createNotebookCellExecution() {
    throw new Error("not implemented");
  },
  resolveExecutable: () => Effect.die("not implemented"),
};

const withTestCtx = Effect.fn(function* (options: {
  disableUvIntegration: boolean;
}) {
  const prompts = yield* Ref.make(0);
  const vscode = yield* TestVsCode.make({
    window: {
      showInformationMessage: <T extends string>() =>
        Ref.update(prompts, (count) => count + 1).pipe(
          Effect.as(Option.none<T>()),
        ),
    },
    workspace: {
      getConfiguration: (section) =>
        Effect.succeed({
          // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
          get: <T>(key: string, defaultValue?: T) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            return (
              section === "marimo" && key === "disableUvIntegration"
                ? options.disableUvIntegration
                : defaultValue
            ) as T;
          },
          has: (key: string) =>
            section === "marimo" && key === "disableUvIntegration",
          inspect: () => undefined,
          async update() {},
        }),
    },
  });
  const editor = TestVsCode.makeNotebookEditor("/project/notebook.py");
  const notebook = MarimoNotebookDocument.from(editor.notebook);
  const layer = Layer.mergeAll(
    vscode.layer,
    Config.Default.pipe(Layer.provide(vscode.layer)),
    PythonEnvInvalidation.Default.pipe(
      Layer.provide(TestPythonExtension.Default),
    ),
    // These tests never reach the install path; any Uv method call is a
    // defect. Layer.mock still requires the non-method properties.
    Layer.mock(Uv, {
      _tag: "Uv",
      bin: { _tag: "Bundled", executable: "uv", version: Option.none() },
      channel: { name: "test", show: () => undefined },
    }),
  );
  return { layer, notebook, prompts };
});

it.scoped("prompts to install missing packages when uv is enabled", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx({ disableUvIntegration: false });
    yield* handleMissingPackageAlert(alert, ctx.notebook, controller).pipe(
      Effect.provide(ctx.layer),
    );
    expect(yield* Ref.get(ctx.prompts)).toBe(1);
  }),
);

it.scoped("skips the install prompt when uv integration is disabled", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx({ disableUvIntegration: true });
    yield* handleMissingPackageAlert(alert, ctx.notebook, controller).pipe(
      Effect.provide(ctx.layer),
    );
    expect(yield* Ref.get(ctx.prompts)).toBe(0);
  }),
);
