import { expect, it } from "@effect/vitest";
import { Effect, Option, Ref } from "effect";
import type * as vscode from "vscode";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import {
  makeTyInstallFailureNotifier,
  ManagedTyInstallPreviouslyFailed,
} from "../TyLanguageServer.ts";

const selectedItem = <T extends string>(
  options: vscode.MessageOptions & { items?: readonly T[] },
  item: string,
) => Option.fromNullishOr(options.items?.find((value) => value === item));

it("keeps recovery instructions in persisted failure diagnostics", () => {
  const error = new ManagedTyInstallPreviouslyFailed({
    extensionVersion: "0.16.2",
    serverVersion: "0.0.63",
    details: "Failed to install ty@0.0.63",
  });

  expect(error.format()).toBe(
    [
      "Failed to install ty@0.0.63",
      "Managed installation will be retried after the marimo extension is updated.",
      "To recover now, install the official ty extension (astral-sh.ty) or configure marimo.ty.path, then reload VS Code.",
      "For full installation output, open the marimo (uv) output channel.",
    ].join("\n"),
  );
});

it.effect(
  "shows the managed installation warning once and can open uv logs",
  Effect.fn(function* () {
    const prompts = yield* Ref.make(0);
    let channelShows = 0;
    const vscode = yield* TestVsCode.make({
      window: {
        showWarningMessage: <T extends string>(
          _message: string,
          options: vscode.MessageOptions & { items?: readonly T[] } = {},
        ) =>
          Ref.update(prompts, (count) => count + 1).pipe(
            Effect.as(selectedItem(options, "Open uv Logs")),
          ),
      },
    });
    const notify = yield* makeTyInstallFailureNotifier({
      name: "marimo (uv)",
      show: () => {
        channelShows += 1;
      },
    }).pipe(Effect.provide(vscode.layer));

    yield* Effect.all([notify, notify], { concurrency: "unbounded" });

    expect(yield* Ref.get(prompts)).toBe(1);
    expect(channelShows).toBe(1);
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
    const notify = yield* makeTyInstallFailureNotifier({
      name: "marimo (uv)",
      show() {},
    }).pipe(Effect.provide(vscode.layer));

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
    const notify = yield* makeTyInstallFailureNotifier({
      name: "marimo (uv)",
      show() {},
    }).pipe(Effect.provide(vscode.layer));

    yield* notify;

    expect(yield* Ref.get(installAttempts)).toBe(1);
    expect(yield* Ref.get(reloadPrompts)).toBe(0);
    expect(yield* Ref.get(errorMessages)).toEqual([
      "VS Code couldn't install the ty extension. Search for @id:astral-sh.ty in the Extensions view.",
    ]);
  }),
);
