import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Vitest from "@effect/vitest";
import { Context, Effect, Layer, Option, Ref } from "effect";

import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import * as Config from "../../config/Config.ts";
import * as PythonEnvInvalidation from "../../python/PythonEnvInvalidation.ts";
import * as Uv from "../../python/Uv.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import type { NotificationOf } from "../../types.ts";
import type * as NotebookRuntime from "../NotebookRuntime.ts";
import { handleMissingPackageAlert } from "../operations.ts";

const alert: NotificationOf<"missing-package-alert"> = {
  op: "missing-package-alert",
  packages: ["polars"],
  isolated: true,
};

// A sandbox-style controller (no `executable`), so the alert goes down the
// script-install path and reaches the prompt without touching the filesystem.
const controller: NotebookRuntime.NotebookController = {
  id: "test-controller",
  drive: () => () => Effect.void,
  presentOutputs: () => Effect.void,
  resolveExecutable: () => Effect.die("not implemented"),
};

interface TestStateInterface {
  readonly notebook: MarimoNotebookDocument;
  readonly recordPrompt: Effect.Effect<void>;
  readonly promptCount: Effect.Effect<number>;
  readonly recordInvalidation: Effect.Effect<boolean>;
  readonly invalidationCount: Effect.Effect<number>;
}

class TestState extends Context.Service<TestState, TestStateInterface>()(
  "@test/operations/State",
) {}

const stateLayer = Layer.effect(
  TestState,
  Effect.gen(function* () {
    const prompts = yield* Ref.make(0);
    const invalidations = yield* Ref.make(0);
    const editor = VsCodeTest.makeNotebookEditor("/project/notebook.py");

    return TestState.of({
      notebook: MarimoNotebookDocument.from(editor.notebook),
      recordPrompt: Ref.update(prompts, (count) => count + 1),
      promptCount: Ref.get(prompts),
      recordInvalidation: Ref.update(invalidations, (count) => count + 1).pipe(
        Effect.as(true),
      ),
      invalidationCount: Ref.get(invalidations),
    });
  }),
);

const uvLayer = Layer.mock(Uv.Service, {
  // Cancellation happens before invoking uv; any Uv method call is a defect.
  // Layer.mock still requires the non-method properties.
  bin: Effect.succeed(
    Uv.UvBin.Bundled({
      executable: "uv",
      version: Option.none(),
    }),
  ),
  channel: { name: "test", show: () => undefined },
});

const layerWith = (options: {
  readonly disableUvIntegration: boolean;
  readonly installAll?: boolean;
}) => {
  const vscodeLayer = Layer.unwrap(
    TestState.pipe(
      Effect.map((state) =>
        VsCodeTest.layerWith(
          {},
          {
            window: {
              showInformationMessage: (_message, messageOptions = {}) =>
                state.recordPrompt.pipe(
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
          },
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(stateLayer));
  const configLayer = Config.layer.pipe(Layer.provide(vscodeLayer));
  const invalidationLayer = Layer.unwrap(
    TestState.pipe(
      Effect.map((state) =>
        Layer.mock(PythonEnvInvalidation.Service, {
          invalidate: () => state.recordInvalidation,
        }),
      ),
    ),
  ).pipe(Layer.provide(vscodeLayer));

  return Layer.mergeAll(vscodeLayer, configLayer, invalidationLayer, uvLayer);
};

const enabledIt = EffectTest.make(layerWith({ disableUvIntegration: false }));
const disabledIt = EffectTest.make(layerWith({ disableUvIntegration: true }));
const installAllIt = EffectTest.make(
  layerWith({ disableUvIntegration: false, installAll: true }),
);

enabledIt.effect("prompts to install missing packages when uv is enabled", () =>
  Effect.gen(function* () {
    const state = yield* TestState;

    yield* handleMissingPackageAlert(alert, state.notebook, controller);

    Vitest.expect(yield* state.promptCount).toBe(1);
  }),
);

disabledIt.effect(
  "skips the install prompt when uv integration is disabled",
  () =>
    Effect.gen(function* () {
      const state = yield* TestState;

      yield* handleMissingPackageAlert(alert, state.notebook, controller);

      Vitest.expect(yield* state.promptCount).toBe(0);
    }),
);

installAllIt.live(
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

      const state = yield* TestState;
      yield* handleMissingPackageAlert(alert, state.notebook, {
        ...controller,
        executable: NodePath.join(venv, "bin", "python"),
      });

      Vitest.expect(yield* state.invalidationCount).toBe(0);
    }),
);
