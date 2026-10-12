import * as Vitest from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import type * as vscode from "vscode";

import * as Config from "../../src/config/Config.ts";
import * as TyLanguageServer from "../../src/lsp/TyLanguageServer.ts";
import * as NotebookVariables from "../../src/panel/variables/NotebookVariables.ts";
import * as ExtensionContext from "../../src/platform/ExtensionContext.ts";
import * as OutputChannel from "../../src/platform/OutputChannel.ts";
import * as Storage from "../../src/platform/Storage.ts";
import * as PythonEnvInvalidation from "../../src/python/PythonEnvInvalidation.ts";
import { Memento } from "../fake/ExtensionContext.ts";
import * as PythonExtensionTest from "../fake/PythonExtension.ts";
import * as TelemetryTest from "../fake/Telemetry.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const DISMISSED_KEY = "languageServer.ty.installPromptDismissed";
const REPLAY_ENV = "MARIMO_REPLAY_TY_PROMPT";

class RecordingMemento extends Memento {
  writes = 0;

  override async update(key: string, value: unknown) {
    this.writes += 1;
    await super.update(key, value);
  }
}

/** The persisted global state backing Storage for one test. */
class GlobalState extends Context.Service<GlobalState, RecordingMemento>()(
  "@marimo/test/TyLanguageServer/GlobalState",
) {}

interface Options {
  readonly installed?: boolean;
  readonly replayDismissal?: boolean;
  readonly failInstall?: boolean;
}

const layerWith = (options: Options = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (options.replayDismissal) {
        const previous = process.env[REPLAY_ENV];
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env[REPLAY_ENV] = "1";
          }),
          () =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env[REPLAY_ENV];
              else process.env[REPLAY_ENV] = previous;
            }),
        );
      }

      const globalState = new RecordingMemento();
      if (options.replayDismissal) {
        yield* Effect.promise(() => globalState.update(DISMISSED_KEY, true));
        globalState.writes = 0;
      }
      const contextLayer = Layer.succeed(ExtensionContext.Service, {
        globalState,
        workspaceState: new Memento(),
        extensionUri: VsCodeTest.Uri.parse("file:///test/extension/path", true),
        globalStorageUri: VsCodeTest.Uri.parse(
          "file://test/extension/libs",
          true,
        ),
      });

      return Layer.mergeAll(
        VsCodeTest.layerWith({
          installedExtensions: options.installed ? ["astral-sh.ty"] : [],
          rejectedCommands: options.failInstall
            ? ["workbench.extensions.installExtension"]
            : [],
        }),
        Storage.layer.pipe(Layer.provide(contextLayer)),
        TelemetryTest.layer,
        Layer.succeed(GlobalState, globalState),
      );
    }),
  );

/**
 * Runs a fresh notifier `times` times, as one new session would. The notifier
 * is cached per session, so calls after the first exercise the suppression path.
 */
const notifyInNewSession = Effect.fn("notifyInNewSession")(function* (
  times = 1,
) {
  const notify = yield* TyLanguageServer.makeMissingNotifier();
  yield* Effect.forEach(Array.from({ length: times }), () => notify, {
    discard: true,
  });
});

const telemetry = Effect.flatMap(
  TelemetryTest.Service,
  (telemetry) => telemetry.tySetupActions,
);

const storage = Effect.map(GlobalState, (state) => state.toJSON());

Vitest.describe("TyLanguageServer", () => {
  Vitest.describe("startup", () => {
    const it = EffectTest.make(VsCodeTest.layer);

    it.effect(
      "accepts an already open marimo notebook",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        yield* vscode.openNotebook(
          VsCodeTest.createTestNotebookDocument("/test/restored.py"),
        );
        yield* TyLanguageServer.waitForNotebook();
      }),
    );

    it.effect(
      "waits through unrelated notebook opens",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        const ready = yield* Ref.make(false);
        const waiter = yield* TyLanguageServer.waitForNotebook().pipe(
          Effect.andThen(Ref.set(ready, true)),
          Effect.forkChild({ startImmediately: true }),
        );
        Vitest.expect(yield* Ref.get(ready)).toBe(false);
        yield* vscode.openNotebook(
          VsCodeTest.createTestNotebookDocument("/test/other.ipynb", {
            notebookType: "jupyter-notebook",
          }),
        );
        yield* Effect.yieldNow;
        Vitest.expect(yield* Ref.get(ready)).toBe(false);
        yield* vscode.openNotebook(
          VsCodeTest.createTestNotebookDocument("/test/opened.py"),
        );
        yield* Fiber.join(waiter);
        Vitest.expect(yield* Ref.get(ready)).toBe(true);
      }),
    );

    it.effect(
      "can shut down while waiting without starting ty",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        const ready = yield* Ref.make(false);
        const waiter = yield* TyLanguageServer.waitForNotebook().pipe(
          Effect.andThen(Ref.set(ready, true)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(waiter);
        yield* vscode.openNotebook(
          VsCodeTest.createTestNotebookDocument("/test/too-late.py"),
        );
        yield* Effect.yieldNow;
        Vitest.expect(yield* Ref.get(ready)).toBe(false);
      }),
    );
  });

  Vitest.describe("layer", () => {
    /** Names of the output channels the server has created so far. */
    class OutputChannels extends Context.Service<
      OutputChannels,
      Ref.Ref<ReadonlyArray<string>>
    >()("@marimo/test/TyLanguageServer/OutputChannels") {}

    interface ServerOptions {
      readonly initialDocuments?: Array<vscode.NotebookDocument>;
      readonly managedFeaturesDisabled?: boolean;
    }

    /**
     * The production layer over fakes. No ty binary is reachable, so a
     * server that decides to start ends in `NotFound` without spawning
     * anything; reaching that state is the observable proof that binary
     * discovery ran.
     */
    const serverLayerWith = (options: ServerOptions = {}) =>
      Layer.unwrap(
        Effect.gen(function* () {
          const channels = yield* Ref.make<ReadonlyArray<string>>([]);
          const contextLayer = Layer.succeed(ExtensionContext.Service, {
            globalState: new Memento(),
            workspaceState: new Memento(),
            extensionUri: VsCodeTest.Uri.parse(
              "file:///test/extension/path",
              true,
            ),
            globalStorageUri: VsCodeTest.Uri.parse(
              "file://test/extension/libs",
              true,
            ),
          });
          const vscodeLayer = VsCodeTest.layerWith(
            { initialDocuments: options.initialDocuments },
            {
              window: {
                createOutputChannel: (name) =>
                  Ref.update(channels, (current) => [...current, name]).pipe(
                    Effect.as<vscode.OutputChannel>({
                      name,
                      dispose() {},
                      append() {},
                      appendLine() {},
                      replace() {},
                      clear() {},
                      show() {},
                      hide() {},
                    }),
                  ),
              },
              workspace: options.managedFeaturesDisabled
                ? {
                    getConfiguration: (section) =>
                      Effect.succeed({
                        // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
                        get: <T>(key: string, defaultValue?: T) => {
                          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                          return (
                            section === "marimo" &&
                            key === "disableManagedLanguageFeatures"
                              ? true
                              : defaultValue
                          ) as T;
                        },
                        has: (key: string) =>
                          section === "marimo" &&
                          key === "disableManagedLanguageFeatures",
                        inspect: () => undefined,
                        async update() {},
                      }),
                  }
                : undefined,
            },
          );
          const fakes = Layer.mergeAll(
            vscodeLayer,
            PythonExtensionTest.layer,
            TelemetryTest.layer,
            Layer.succeed(OutputChannels, channels),
          );
          return TyLanguageServer.layer.pipe(
            Layer.provide([
              Config.layer,
              OutputChannel.layer,
              NotebookVariables.defaultLayer,
              PythonEnvInvalidation.layer,
              Storage.layer.pipe(Layer.provide(contextLayer)),
            ]),
            Layer.provideMerge(fakes),
          );
        }),
      );

    /** Polls the health status until the background fiber has settled. */
    const settledStatus = Effect.fn("settledStatus")(function* () {
      const ty = yield* TyLanguageServer.Service;
      let status = yield* ty.getHealthStatus;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (status._tag !== "Idle" && status._tag !== "Starting") break;
        yield* Effect.yieldNow;
        status = yield* ty.getHealthStatus;
      }
      return status;
    });

    /** Gives the background fiber a few turns without waiting for anything. */
    const settle = Effect.forEach(
      Array.from({ length: 10 }),
      () => Effect.yieldNow,
      { discard: true },
    );

    const expectIdle = Effect.fn("expectIdle")(function* () {
      const ty = yield* TyLanguageServer.Service;
      const vscode = yield* VsCodeTest.Service;
      yield* settle;
      Vitest.expect((yield* ty.getHealthStatus)._tag).toBe("Idle");
      Vitest.expect(yield* Ref.get(yield* OutputChannels)).toEqual([]);
      Vitest.expect((yield* vscode.snapshot).warningMessages).toEqual([]);
    });

    Vitest.describe("without a marimo notebook", () => {
      const it = EffectTest.make(serverLayerWith());

      it.effect(
        "does not look for ty until a marimo notebook opens",
        Effect.fn(function* () {
          const vscode = yield* VsCodeTest.Service;
          yield* expectIdle();

          yield* vscode.openNotebook(
            VsCodeTest.createTestNotebookDocument("/test/other.ipynb", {
              notebookType: "jupyter-notebook",
            }),
          );
          yield* expectIdle();

          yield* vscode.openNotebook(
            VsCodeTest.createTestNotebookDocument("/test/opened.py"),
          );
          Vitest.expect((yield* settledStatus())._tag).toBe("NotFound");
          Vitest.expect(yield* Ref.get(yield* OutputChannels)).toEqual([
            "marimo (ty)",
          ]);
          Vitest.expect((yield* vscode.snapshot).warningMessages).toHaveLength(
            1,
          );
        }),
      );

      it.effect(
        "stops ty once the last marimo notebook has stayed closed",
        Effect.fn(function* () {
          const ty = yield* TyLanguageServer.Service;
          const vscode = yield* VsCodeTest.Service;
          const telemetry = yield* TelemetryTest.Service;
          const first = VsCodeTest.createTestNotebookDocument("/test/first.py");
          yield* vscode.openNotebook(first);
          Vitest.expect((yield* settledStatus())._tag).toBe("NotFound");

          yield* vscode.closeNotebook(first);
          yield* settle;
          yield* TestClock.adjust("5 seconds");
          yield* settle;
          Vitest.expect((yield* ty.getHealthStatus)._tag).toBe("Idle");

          // The next notebook starts a fresh lookup on the same channel.
          yield* vscode.openNotebook(
            VsCodeTest.createTestNotebookDocument("/test/second.py"),
          );
          Vitest.expect((yield* settledStatus())._tag).toBe("NotFound");
          Vitest.expect(yield* telemetry.unresolvedBinaries).toEqual([
            "ty",
            "ty",
          ]);
          Vitest.expect(yield* Ref.get(yield* OutputChannels)).toEqual([
            "marimo (ty)",
          ]);
          Vitest.expect((yield* vscode.snapshot).warningMessages).toHaveLength(
            1,
          );
        }),
      );

      it.effect(
        "keeps ty running when a notebook reopens within the grace period",
        Effect.fn(function* () {
          const ty = yield* TyLanguageServer.Service;
          const vscode = yield* VsCodeTest.Service;
          const telemetry = yield* TelemetryTest.Service;
          const first = VsCodeTest.createTestNotebookDocument("/test/first.py");
          yield* vscode.openNotebook(first);
          Vitest.expect((yield* settledStatus())._tag).toBe("NotFound");

          yield* vscode.closeNotebook(first);
          yield* settle;
          yield* TestClock.adjust("2 seconds");
          yield* vscode.openNotebook(
            VsCodeTest.createTestNotebookDocument("/test/second.py"),
          );
          yield* settle;
          yield* TestClock.adjust("10 seconds");
          yield* settle;
          Vitest.expect((yield* ty.getHealthStatus)._tag).toBe("NotFound");
          Vitest.expect(yield* telemetry.unresolvedBinaries).toEqual(["ty"]);
        }),
      );
    });

    Vitest.describe("with a restored marimo notebook", () => {
      const it = EffectTest.make(
        serverLayerWith({
          initialDocuments: [
            VsCodeTest.createTestNotebookDocument("/test/restored.py"),
          ],
        }),
      );

      it.effect(
        "looks for ty right away",
        Effect.fn(function* () {
          Vitest.expect((yield* settledStatus())._tag).toBe("NotFound");
          Vitest.expect(yield* Ref.get(yield* OutputChannels)).toEqual([
            "marimo (ty)",
          ]);
        }),
      );
    });

    Vitest.describe("with managed language features disabled", () => {
      const it = EffectTest.make(
        serverLayerWith({ managedFeaturesDisabled: true }),
      );

      it.effect(
        "stays disabled when a marimo notebook opens",
        Effect.fn(function* () {
          const ty = yield* TyLanguageServer.Service;
          const vscode = yield* VsCodeTest.Service;
          yield* vscode.openNotebook(
            VsCodeTest.createTestNotebookDocument("/test/opened.py"),
          );
          yield* settle;
          Vitest.expect((yield* ty.getHealthStatus)._tag).toBe("Disabled");
          Vitest.expect(yield* Ref.get(yield* OutputChannels)).toEqual([]);
        }),
      );
    });
  });

  Vitest.it(
    "points at the ty extension and the path setting when no binary is found",
    () => {
      const error = new TyLanguageServer.BinaryNotFoundError({
        serverVersion: "0.0.63",
      });

      Vitest.expect(error.format()).toBe(
        [
          "No ty 0.0.63 or newer binary was found.",
          "Python completions and type diagnostics are unavailable. You can still edit and run notebooks.",
          "To enable these features, install or update the official ty extension (astral-sh.ty) or set marimo.ty.path, then reload VS Code.",
        ].join("\n"),
      );
    },
  );

  Vitest.describe("when the prompt is ignored", () => {
    const it = EffectTest.make(layerWith());

    it.effect(
      "warns about unavailable Python language features at most once per session",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        const notify = yield* TyLanguageServer.makeMissingNotifier();
        yield* Effect.all([notify, notify], { concurrency: "unbounded" });

        Vitest.expect((yield* vscode.snapshot).warningMessages).toEqual([
          "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Install the recommended ty extension to enable them. You can still edit and run notebooks.",
        ]);
      }),
    );
  });

  Vitest.describe("when the prompt is permanently dismissed", () => {
    const it = EffectTest.make(layerWith());

    it.effect(
      "never prompts again once the user dismisses it",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        yield* vscode.selectWarningMessage("Don't Show Again");
        const notify = yield* TyLanguageServer.makeMissingNotifier();
        yield* notify;
        yield* notifyInNewSession();

        Vitest.expect((yield* vscode.snapshot).warningMessages).toHaveLength(1);
        Vitest.expect(yield* storage).toEqual({
          "languageServer.ty.installPromptDismissed": true,
        });
        Vitest.expect(yield* telemetry).toEqual([
          "prompt_shown",
          "dont_show_again",
          "prompt_suppressed",
        ]);
      }),
    );
  });

  Vitest.describe("when replaying the prompt during local development", () => {
    const it = EffectTest.make(layerWith({ replayDismissal: true }));

    it.effect(
      "replays saved dismissals without writing state during local development",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        const state = yield* GlobalState;
        yield* vscode.selectWarningMessage("Don't Show Again");
        yield* vscode.selectWarningMessage("Don't Show Again");
        const notify = yield* TyLanguageServer.makeMissingNotifier();
        yield* notify;
        yield* notify;
        yield* notifyInNewSession(2);

        Vitest.expect((yield* vscode.snapshot).warningMessages).toHaveLength(2);
        Vitest.expect(state.writes).toBe(0);
        Vitest.expect(yield* storage).toEqual({
          "languageServer.ty.installPromptDismissed": true,
        });
      }),
    );
  });

  Vitest.describe("when installing the companion extension", () => {
    const it = EffectTest.make(layerWith());

    it.effect(
      "installs the companion extension and reloads when selected",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        yield* vscode.selectWarningMessage("Install ty Extension");
        yield* vscode.selectInformationMessage("Reload Window");
        yield* yield* TyLanguageServer.makeMissingNotifier();

        Vitest.expect(yield* storage).toEqual({});
        Vitest.expect(yield* telemetry).toEqual([
          "prompt_shown",
          "install",
          "install_succeeded",
        ]);
        Vitest.expect((yield* vscode.snapshot).executions).toEqual([
          {
            command: "workbench.extensions.installExtension",
            args: ["astral-sh.ty"],
          },
          { command: "workbench.action.reloadWindow", args: [] },
        ]);
      }),
    );
  });

  Vitest.describe("when the companion extension is already installed", () => {
    const it = EffectTest.make(layerWith({ installed: true }));

    it.effect(
      "asks an existing ty extension to be updated instead of installed",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        yield* vscode.selectWarningMessage("Show ty Extension");
        yield* vscode.selectWarningMessage("Show ty Extension");
        yield* yield* TyLanguageServer.makeMissingNotifier();
        yield* notifyInNewSession();

        const snapshot = yield* vscode.snapshot;
        Vitest.expect(snapshot.warningMessages).toEqual([
          "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Update the ty extension to enable them. You can still edit and run notebooks.",
          "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Update the ty extension to enable them. You can still edit and run notebooks.",
        ]);
        Vitest.expect(snapshot.executions).toEqual([
          { command: "extension.open", args: ["astral-sh.ty"] },
          { command: "extension.open", args: ["astral-sh.ty"] },
        ]);
        Vitest.expect(yield* storage).toEqual({});
      }),
    );
  });

  Vitest.describe("when installation fails", () => {
    const it = EffectTest.make(layerWith({ failInstall: true }));

    it.effect(
      "reports a companion extension installation failure without prompting to reload",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        yield* vscode.selectWarningMessage("Install ty Extension");
        yield* yield* TyLanguageServer.makeMissingNotifier();

        const snapshot = yield* vscode.snapshot;
        Vitest.expect(snapshot.executions).toEqual([
          {
            command: "workbench.extensions.installExtension",
            args: ["astral-sh.ty"],
          },
        ]);
        Vitest.expect(yield* telemetry).toEqual([
          "prompt_shown",
          "install",
          "install_failed",
        ]);
        Vitest.expect(snapshot.informationMessages).toEqual([]);
        Vitest.expect(snapshot.errorMessages).toEqual([
          "VS Code couldn't install the ty extension. Search for @id:astral-sh.ty in the Extensions view.",
        ]);
      }),
    );
  });
});
