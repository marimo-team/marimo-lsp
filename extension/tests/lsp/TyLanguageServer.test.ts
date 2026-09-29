import * as Vitest from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import * as TyLanguageServer from "../../src/lsp/TyLanguageServer.ts";
import * as ExtensionContext from "../../src/platform/ExtensionContext.ts";
import * as Storage from "../../src/platform/Storage.ts";
import { Memento } from "../fake/ExtensionContext.ts";
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
