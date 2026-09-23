import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";
import { afterEach, vi } from "vite-plus/test";
import type * as vscode from "vscode";

import { Memento } from "../../__mocks__/TestExtensionContext.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode, Uri } from "../../__mocks__/TestVsCode.ts";
import * as ExtensionContext from "../../platform/ExtensionContext.ts";
import * as Storage from "../../platform/Storage.ts";
import * as Telemetry from "../../telemetry/Telemetry.ts";
import * as TyLanguageServer from "../TyLanguageServer.ts";

const selectedItem = <T extends string>(
  options: vscode.MessageOptions & { items?: readonly T[] },
  item: string,
) => Option.fromNullishOr(options.items?.find((value) => value === item));

/**
 * A storage layer backed by its own mementos, so a dismissal recorded by one
 * test can't leak into the next.
 */
const freshStorage = (globalState = new Memento()) =>
  Storage.layer.pipe(
    Layer.provide(
      Layer.succeed(ExtensionContext.Service, {
        globalState,
        workspaceState: new Memento(),
        extensionUri: Uri.parse("file:///test/extension/path", true),
        globalStorageUri: Uri.parse("file://test/extension/libs", true),
      }),
    ),
  );

afterEach(() => vi.unstubAllEnvs());

const recordTelemetry = Effect.gen(function* () {
  const base = yield* Telemetry.Service.pipe(Effect.provide(TestTelemetryLive));
  const events: string[] = [];
  const record = (event: string) =>
    Effect.sync(() => {
      events.push(event);
    });
  return {
    events,
    layer: Layer.succeed(Telemetry.Service, {
      ...base,
      tySetup: record,
    }),
  };
});

it("points at the ty extension and the path setting when no binary is found", () => {
  const error = new TyLanguageServer.BinaryNotFoundError({
    serverVersion: "0.0.63",
  });

  expect(error.format()).toBe(
    [
      "No ty 0.0.63 or newer binary was found.",
      "Python completions and type diagnostics are unavailable. You can still edit and run notebooks.",
      "To enable these features, install or update the official ty extension (astral-sh.ty) or set marimo.ty.path, then reload VS Code.",
    ].join("\n"),
  );
});

it.effect(
  "warns about unavailable Python language features at most once per session",
  Effect.fn(function* () {
    const prompts = yield* Ref.make<ReadonlyArray<string>>([]);
    const vscode = yield* TestVsCode.make({
      window: {
        showWarningMessage: (message) =>
          Ref.update(prompts, (all) => [...all, message]).pipe(
            Effect.as(Option.none()),
          ),
      },
    });
    const notify = yield* TyLanguageServer.makeMissingNotifier().pipe(
      Effect.provide([vscode.layer, freshStorage()]),
    );

    yield* Effect.all([notify, notify], { concurrency: "unbounded" });

    expect(yield* Ref.get(prompts)).toEqual([
      "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Install the recommended ty extension to enable them. You can still edit and run notebooks.",
    ]);
  }),
);

it.effect(
  "never prompts again once the user dismisses it",
  Effect.fn(function* () {
    const telemetry = yield* recordTelemetry;
    const prompts = yield* Ref.make(0);
    const vscode = yield* TestVsCode.make({
      window: {
        showWarningMessage: <T extends string>(
          _message: string,
          options: vscode.MessageOptions & { items?: readonly T[] } = {},
        ) =>
          Ref.update(prompts, (count) => count + 1).pipe(
            Effect.as(selectedItem(options, "Don't Show Again")),
          ),
      },
    });
    const layers = Layer.mergeAll(
      vscode.layer,
      freshStorage(),
      telemetry.layer,
    );

    // A fresh notifier stands in for a fresh session; the dismissal has to
    // outlive both of them.
    yield* Effect.flatten(TyLanguageServer.makeMissingNotifier()).pipe(
      Effect.provide(layers),
    );
    yield* Effect.flatten(TyLanguageServer.makeMissingNotifier()).pipe(
      Effect.provide(layers),
    );

    expect(yield* Ref.get(prompts)).toBe(1);
    expect(telemetry.events).toEqual([
      "prompt_shown",
      "dont_show_again",
      "prompt_suppressed",
    ]);
  }),
);

it.effect(
  "replays saved dismissals without writing state during local development",
  Effect.fn(function* () {
    vi.stubEnv("MARIMO_REPLAY_TY_PROMPT", "1");
    const globalState = new Memento();
    yield* Effect.promise(() =>
      globalState.update("languageServer.ty.installPromptDismissed", true),
    );
    const writes = vi.spyOn(globalState, "update");
    const prompts = yield* Ref.make(0);
    const vscode = yield* TestVsCode.make({
      window: {
        showWarningMessage: <T extends string>(
          _message: string,
          options: vscode.MessageOptions & { items?: readonly T[] } = {},
        ) =>
          Ref.update(prompts, (count) => count + 1).pipe(
            Effect.as(selectedItem(options, "Don't Show Again")),
          ),
      },
    });
    const layers = Layer.mergeAll(vscode.layer, freshStorage(globalState));

    for (let session = 0; session < 2; session++) {
      const notify = yield* TyLanguageServer.makeMissingNotifier().pipe(
        Effect.provide(layers),
      );
      yield* notify;
      yield* notify;
    }

    expect(yield* Ref.get(prompts)).toBe(2);
    expect(writes).not.toHaveBeenCalled();
    expect(globalState.toJSON()).toEqual({
      "languageServer.ty.installPromptDismissed": true,
    });
  }),
);

it.effect(
  "installs the companion extension and reloads when selected",
  Effect.fn(function* () {
    const telemetry = yield* recordTelemetry;
    const globalState = new Memento();
    const vscode = yield* TestVsCode.make({
      window: {
        showWarningMessage: <T extends string>(
          _message: string,
          options: vscode.MessageOptions & { items?: readonly T[] } = {},
        ) => Effect.succeed(selectedItem(options, "Install ty Extension")),
        showInformationMessage: <T extends string>(
          _message: string,
          options: vscode.MessageOptions & { items?: readonly T[] } = {},
        ) => Effect.succeed(selectedItem(options, "Reload Window")),
      },
    });
    const notify = yield* TyLanguageServer.makeMissingNotifier().pipe(
      Effect.provide([
        vscode.layer,
        freshStorage(globalState),
        telemetry.layer,
      ]),
    );

    yield* notify;

    expect(
      globalState.get("languageServer.ty.installPromptDismissed"),
    ).toBeUndefined();
    expect(telemetry.events).toEqual([
      "prompt_shown",
      "install",
      "install_succeeded",
    ]);

    expect(yield* Ref.get(vscode.executions)).toEqual([
      {
        command: "workbench.extensions.installExtension",
        args: ["astral-sh.ty"],
      },
      { command: "workbench.action.reloadWindow", args: [] },
    ]);
  }),
);

it.effect(
  "asks an existing ty extension to be updated instead of installed",
  Effect.fn(function* () {
    const prompts = yield* Ref.make<ReadonlyArray<string>>([]);
    const vscode = yield* TestVsCode.make({
      installedExtensions: ["astral-sh.ty"],
      window: {
        showWarningMessage: <T extends string>(
          message: string,
          options: vscode.MessageOptions & { items?: readonly T[] } = {},
        ) =>
          Ref.update(prompts, (all) => [...all, message]).pipe(
            Effect.as(selectedItem(options, "Show ty Extension")),
          ),
      },
    });
    const storage = freshStorage();
    const layers = Layer.mergeAll(vscode.layer, storage);

    yield* Effect.flatten(TyLanguageServer.makeMissingNotifier()).pipe(
      Effect.provide(layers),
    );

    expect(yield* Ref.get(prompts)).toEqual([
      "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Update the ty extension to enable them. You can still edit and run notebooks.",
    ]);
    expect(yield* Ref.get(vscode.executions)).toEqual([
      { command: "extension.open", args: ["astral-sh.ty"] },
    ]);

    // Opening the extension page isn't a dismissal — a user who ignores the
    // update should be reminded in a later session.
    yield* Effect.flatten(TyLanguageServer.makeMissingNotifier()).pipe(
      Effect.provide(layers),
    );
    expect(yield* Ref.get(prompts)).toHaveLength(2);
  }),
);

it.effect(
  "reports a companion extension installation failure without prompting to reload",
  Effect.fn(function* () {
    const telemetry = yield* recordTelemetry;
    const installAttempts = yield* Ref.make(0);
    const errorMessages = yield* Ref.make<ReadonlyArray<string>>([]);
    const reloadPrompts = yield* Ref.make(0);
    const vscode = yield* TestVsCode.make({
      window: {
        showWarningMessage: <T extends string>(
          _message: string,
          options: vscode.MessageOptions & { items?: readonly T[] } = {},
        ) => Effect.succeed(selectedItem(options, "Install ty Extension")),
        showInformationMessage: () =>
          Ref.update(reloadPrompts, (count) => count + 1).pipe(
            Effect.as(Option.none()),
          ),
        showErrorMessage: (message) =>
          Ref.update(errorMessages, (messages) => [...messages, message]).pipe(
            Effect.as(Option.none()),
          ),
      },
      commands: {
        executeVSCode: () =>
          Ref.update(installAttempts, (count) => count + 1).pipe(
            Effect.andThen(Effect.die(new Error("command rejected"))),
          ),
      },
    });
    const notify = yield* TyLanguageServer.makeMissingNotifier().pipe(
      Effect.provide([vscode.layer, freshStorage(), telemetry.layer]),
    );

    yield* notify;

    expect(yield* Ref.get(installAttempts)).toBe(1);
    expect(telemetry.events).toEqual([
      "prompt_shown",
      "install",
      "install_failed",
    ]);
    expect(yield* Ref.get(reloadPrompts)).toBe(0);
    expect(yield* Ref.get(errorMessages)).toEqual([
      "VS Code couldn't install the ty extension. Search for @id:astral-sh.ty in the Extensions view.",
    ]);
  }),
);
