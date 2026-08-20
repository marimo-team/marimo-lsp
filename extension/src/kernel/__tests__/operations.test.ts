import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Stream } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { Config } from "../../config/Config.ts";
import { PythonEnvInvalidation } from "../../python/PythonEnvInvalidation.ts";
import { Uv, UvBin } from "../../python/Uv.ts";
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
  drive: () => () => Effect.void,
  resolveEnvironment: () => Effect.die("not implemented"),
};

const withTestCtx = Effect.fn(function* (options: {
  disableUvIntegration: boolean;
  installAll?: boolean;
}) {
  const prompts = yield* Ref.make(0);
  const invalidations = yield* Ref.make(0);
  const vscode = yield* TestVsCode.make({
    window: {
      showInformationMessage: (_message, messageOptions = {}) =>
        Ref.update(prompts, (count) => count + 1).pipe(
          Effect.as(
            options.installAll
              ? Option.fromNullishOr(messageOptions.items?.[0])
              : Option.none(),
          ),
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
    Config.layer.pipe(Layer.provide(vscode.layer)),
    Layer.succeed(PythonEnvInvalidation, {
      invalidate: () =>
        Ref.update(invalidations, (count) => count + 1).pipe(Effect.as(true)),
      changes: Stream.empty,
    }),
    // Cancellation happens before invoking uv; any Uv method call is a defect.
    // Layer.mock still requires the non-method properties.
    Layer.mock(Uv, {
      bin: Effect.succeed(
        UvBin.Bundled({
          executable: "uv",
          version: Option.none(),
        }),
      ),
      channel: { name: "test", show: () => undefined },
    }),
  );
  return { layer, notebook, prompts, invalidations };
});

it.effect("prompts to install missing packages when uv is enabled", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx({ disableUvIntegration: false });
    yield* handleMissingPackageAlert(alert, ctx.notebook, controller).pipe(
      Effect.provide(ctx.layer),
    );
    expect(yield* Ref.get(ctx.prompts)).toBe(1);
  }),
);

it.effect("skips the install prompt when uv integration is disabled", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx({ disableUvIntegration: true });
    yield* handleMissingPackageAlert(alert, ctx.notebook, controller).pipe(
      Effect.provide(ctx.layer),
    );
    expect(yield* Ref.get(ctx.prompts)).toBe(0);
  }),
);

it.effect(
  "does not invalidate the environment when placement is cancelled",
  () =>
    Effect.gen(function* () {
      using project = NodeFs.mkdtempDisposableSync(
        NodePath.join(NodeOs.tmpdir(), "marimo-operations-"),
      );
      const venv = NodePath.join(project.path, ".venv");
      NodeFs.mkdirSync(NodePath.join(venv, "bin"), { recursive: true });
      NodeFs.writeFileSync(NodePath.join(venv, "pyvenv.cfg"), "");
      NodeFs.writeFileSync(
        NodePath.join(project.path, "pyproject.toml"),
        `
[project]
dependencies = ["polars"]

[dependency-groups]
dev = ["polars"]
`,
      );

      const ctx = yield* withTestCtx({
        disableUvIntegration: false,
        installAll: true,
      });
      yield* handleMissingPackageAlert(alert, ctx.notebook, {
        ...controller,
        executable: NodePath.join(venv, "bin", "python"),
      }).pipe(Effect.provide(ctx.layer));

      expect(yield* Ref.get(ctx.invalidations)).toBe(0);
    }),
);
