import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Option, Queue, Ref, Stream } from "effect";
import type * as vscode from "vscode";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { commandId } from "../../commands.ts";
import restartKernel from "../../commands/restartKernel.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import {
  promptToRestartKernelForFileRootChange,
  watchForConfigurationChanges,
} from "../ReloadOnConfigChange.ts";

it.scoped(
  "runs the restart command only when selected",
  Effect.fn(function* () {
    let acceptRestart = true;
    const vscode = yield* TestVsCode.make({
      window: {
        showInformationMessage: (_message, options = {}) =>
          Effect.succeed(
            acceptRestart
              ? Option.fromNullable(
                  options.items?.find((item) => item === "Restart Kernel"),
                )
              : Option.none(),
          ),
      },
    });
    yield* promptToRestartKernelForFileRootChange().pipe(
      Effect.provide(vscode.layer),
    );
    expect(yield* Ref.get(vscode.executions)).toContainEqual({
      command: commandId(restartKernel.command),
      args: [],
    });

    acceptRestart = false;
    yield* promptToRestartKernelForFileRootChange().pipe(
      Effect.provide(vscode.layer),
    );
    expect(yield* Ref.get(vscode.executions)).toHaveLength(1);
  }),
);

it.scoped(
  "reloads after telemetry changes only when selected",
  Effect.fn(function* () {
    const prompted = yield* Queue.unbounded<void>();
    let acceptReload = true;
    const configurationChange: vscode.ConfigurationChangeEvent = {
      affectsConfiguration: (section) => section === "marimo.telemetry",
    };
    const vscode = yield* TestVsCode.make({
      window: {
        showInformationMessage: <T extends string>(
          message: string,
          options: vscode.MessageOptions & { items?: readonly T[] } = {},
        ) => {
          expect(message).toBe(
            "Changing telemetry requires reloading the window to take effect.",
          );
          const selection = acceptReload
            ? Option.fromNullable(
                options.items?.find((item) => item === "Reload Window"),
              )
            : Option.none<T>();
          acceptReload = false;
          return Queue.offer(prompted, undefined).pipe(Effect.as(selection));
        },
      },
      workspace: {
        configurationChanges: () =>
          Stream.make(configurationChange, configurationChange),
      },
    });
    const services = Layer.merge(vscode.layer, makeTestNotebookRuntime());

    yield* watchForConfigurationChanges().pipe(Effect.provide(services));
    yield* Queue.take(prompted);
    yield* Queue.take(prompted);

    expect(yield* Ref.get(vscode.executions)).toEqual([
      {
        command: "workbench.action.reloadWindow",
        args: [],
      },
    ]);
  }),
);

it.scoped(
  "prompts when an affected inactive RuntimeSession becomes active",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor("/project/notebook.py");
    const id = notebookId(editor.notebook.uri.toString());
    const prompts = yield* Ref.make(0);
    const prompted = yield* Deferred.make<void>();
    const activeEditor = yield* Ref.make<Option.Option<vscode.NotebookEditor>>(
      Option.none(),
    );
    let resolveResourceChecked: (() => void) | undefined;
    const resourceChecked = new Promise<void>((resolve) => {
      resolveResourceChecked = resolve;
    });
    const configurationChange: vscode.ConfigurationChangeEvent = {
      affectsConfiguration: (section, resource) => {
        const affected =
          section === "marimo.notebookFileRoot" &&
          (resource === undefined ||
            ("scheme" in resource &&
              resource.scheme === editor.notebook.uri.scheme &&
              resource.path === editor.notebook.uri.path));
        if (affected && resource !== undefined) {
          resolveResourceChecked?.();
        }
        return affected;
      },
    };
    const vscode = yield* TestVsCode.make({
      window: {
        getActiveNotebookEditor: () => Ref.get(activeEditor),
        activeNotebookEditorChanges: () =>
          Stream.fromEffect(
            Effect.promise(() => resourceChecked).pipe(
              Effect.andThen(Ref.set(activeEditor, Option.some(editor))),
              Effect.as(Option.some(editor)),
            ),
          ),
        showInformationMessage: <T extends string>() =>
          Ref.update(prompts, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(prompted, undefined)),
            Effect.as(Option.none<T>()),
          ),
      },
      workspace: {
        configurationChanges: () => Stream.make(configurationChange),
      },
    });
    const session = {
      executable: "/python",
      workingDirectory: "/project",
    };
    const services = Layer.merge(
      vscode.layer,
      makeTestNotebookRuntime({
        runtimeSession: session,
        runtimeSessions: [{ notebookId: id, session }],
      }),
    );
    yield* watchForConfigurationChanges().pipe(Effect.provide(services));

    yield* Deferred.await(prompted);
    expect(yield* Ref.get(prompts)).toBe(1);
  }),
);
