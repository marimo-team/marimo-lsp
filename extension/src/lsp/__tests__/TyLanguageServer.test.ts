import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";
import type * as vscode from "vscode";

import { Memento } from "../../__mocks__/TestExtensionContext.ts";
import { TestVsCode, Uri } from "../../__mocks__/TestVsCode.ts";
import { ExtensionContext, Storage } from "../../platform/Storage.ts";
import {
  makeTyMissingNotifier,
  TyBinaryNotFound,
} from "../TyLanguageServer.ts";

const selectedItem = <T extends string>(
  options: vscode.MessageOptions & { items?: readonly T[] },
  item: string,
) => Option.fromNullishOr(options.items?.find((value) => value === item));

/**
 * A storage layer backed by its own mementos, so a dismissal recorded by one
 * test can't leak into the next.
 */
const freshStorage = () =>
  Storage.layer.pipe(
    Layer.provide(
      Layer.succeed(ExtensionContext, {
        globalState: new Memento(),
        workspaceState: new Memento(),
        extensionUri: Uri.parse("file:///test/extension/path", true),
        globalStorageUri: Uri.parse("file://test/extension/libs", true),
      }),
    ),
  );

it("points at the ty extension and the path setting when no binary is found", () => {
  const error = new TyBinaryNotFound({ serverVersion: "0.0.63" });

  expect(error.format()).toBe(
    [
      "No ty 0.0.63 or newer binary was found.",
      "Install or update the official ty extension (astral-sh.ty) or set marimo.ty.path, then reload VS Code.",
    ].join("\n"),
  );
});

it.effect(
  "shows the missing-ty warning at most once per session",
  Effect.fn(function* () {
    const prompts = yield* Ref.make(0);
    const vscode = yield* TestVsCode.make({
      window: {
        showWarningMessage: () =>
          Ref.update(prompts, (count) => count + 1).pipe(
            Effect.as(Option.none()),
          ),
      },
    });
    const notify = yield* makeTyMissingNotifier().pipe(
      Effect.provide([vscode.layer, freshStorage()]),
    );

    yield* Effect.all([notify, notify], { concurrency: "unbounded" });

    expect(yield* Ref.get(prompts)).toBe(1);
  }),
);

it.effect(
  "never prompts again once the user dismisses it",
  Effect.fn(function* () {
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
    const layers = Layer.mergeAll(vscode.layer, freshStorage());

    // A fresh notifier stands in for a fresh session; the dismissal has to
    // outlive both of them.
    yield* Effect.flatten(makeTyMissingNotifier()).pipe(Effect.provide(layers));
    yield* Effect.flatten(makeTyMissingNotifier()).pipe(Effect.provide(layers));

    expect(yield* Ref.get(prompts)).toBe(1);
  }),
);

it.effect(
  "installs the companion extension and reloads when selected",
  Effect.fn(function* () {
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
    const notify = yield* makeTyMissingNotifier().pipe(
      Effect.provide([vscode.layer, freshStorage()]),
    );

    yield* notify;

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
    const warnings = yield* Ref.make<ReadonlyArray<string>>([]);
    const vscode = yield* TestVsCode.make({
      installedExtensions: ["astral-sh.ty"],
      window: {
        showWarningMessage: <T extends string>(
          message: string,
          options: vscode.MessageOptions & { items?: readonly T[] } = {},
        ) =>
          Ref.update(warnings, (all) => [...all, message]).pipe(
            Effect.as(selectedItem(options, "Show ty Extension")),
          ),
      },
    });
    const storage = freshStorage();
    const layers = Layer.mergeAll(vscode.layer, storage);

    yield* Effect.flatten(makeTyMissingNotifier()).pipe(Effect.provide(layers));

    expect(yield* Ref.get(warnings)).toEqual([
      "The installed ty extension is too old for marimo notebooks. Update it to restore Python completions and diagnostics.",
    ]);
    expect(yield* Ref.get(vscode.executions)).toEqual([
      { command: "extension.open", args: ["astral-sh.ty"] },
    ]);

    // Opening the extension page isn't a dismissal — a user who ignores the
    // update should be reminded in a later session.
    yield* Effect.flatten(makeTyMissingNotifier()).pipe(Effect.provide(layers));
    expect(yield* Ref.get(warnings)).toHaveLength(2);
  }),
);

it.effect(
  "reports a companion extension installation failure without prompting to reload",
  Effect.fn(function* () {
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
    const notify = yield* makeTyMissingNotifier().pipe(
      Effect.provide([vscode.layer, freshStorage()]),
    );

    yield* notify;

    expect(yield* Ref.get(installAttempts)).toBe(1);
    expect(yield* Ref.get(reloadPrompts)).toBe(0);
    expect(yield* Ref.get(errorMessages)).toEqual([
      "VS Code couldn't install the ty extension. Search for @id:astral-sh.ty in the Extensions view.",
    ]);
  }),
);
