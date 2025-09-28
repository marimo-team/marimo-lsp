import { type Cause, Effect, FiberSet } from "effect";
import * as vscode from "vscode";
import type { AssertionError } from "../assert.ts";
import type { VsCodeWindowError } from "./VsCodeWindow.ts";
import type { VsCodeWorkspaceError } from "./VsCodeWorkspace.ts";

export class VsCodeCommands extends Effect.Service<VsCodeCommands>()(
  "VsCodeCommands",
  {
    scoped: Effect.gen(function* () {
      const runPromise = yield* FiberSet.makeRuntimePromise();
      return {
        registerCommand(
          command: string,
          effect: Effect.Effect<
            void,
            | AssertionError
            | Cause.UnknownException
            | VsCodeWorkspaceError
            | VsCodeWindowError,
            never
          >,
        ) {
          return Effect.acquireRelease(
            Effect.sync(() =>
              vscode.commands.registerCommand(command, () =>
                runPromise<never, void>(
                  effect.pipe(
                    Effect.catchAllCause((cause) =>
                      Effect.gen(function* () {
                        yield* Effect.logError(cause);
                        yield* Effect.promise(() =>
                          vscode.window.showWarningMessage(
                            `Something went wrong in ${JSON.stringify(command)}. See marimo logs for more info.`,
                          ),
                        );
                      }),
                    ),
                  ),
                ),
              ),
            ),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
      };
    }),
  },
) {}
