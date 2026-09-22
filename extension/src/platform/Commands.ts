import {
  Context,
  Effect,
  Layer,
  PubSub,
  Result,
  type Schema,
  Scope,
} from "effect";
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";

import {
  type CommandArguments,
  type CommandDefinition,
  commandId,
  decodeCommandArguments,
  decodeCommandResult,
  type MarimoCommand,
  type VscodeBuiltinCommand,
  type VscodeCommandArgs,
  type VscodeCommandResult,
} from "../commands.ts";
import type { MarimoContextKey } from "../constants.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { isExpectedCancellation } from "../lib/isExpectedCancellation.ts";
import * as Window from "./Window.ts";

type ContextMap = {
  "marimo.hasLiveSessions": boolean;
  "marimo.config.runtime.on_cell_change": "autorun" | "lazy";
  "marimo.config.runtime.auto_reload": "off" | "lazy" | "autorun";
  "marimo.isPythonFileMarimoNotebook": boolean;
  "marimo.notebook.hasStaleCells": boolean;
  "marimo.notebook.hasKernel": boolean;
};

export const withCommandContext = (command: MarimoCommand) => {
  const wireId = commandId(command);
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapCause((cause) =>
        isExpectedCancellation(cause) ? Effect.void : Effect.logError(cause),
      ),
      Effect.annotateLogs({ "command.id": wireId }),
    );
};

export interface Interface {
  readonly subscribeToCommands: Effect.Effect<
    PubSub.Subscription<Result.Result<string, string>>,
    never,
    Scope.Scope
  >;
  readonly execute: <
    CallArgs extends CommandArguments,
    HandlerArgs extends CommandArguments,
    A,
    DecodeRequirements,
  >(
    command: MarimoCommand<CallArgs, HandlerArgs, A, DecodeRequirements>,
    ...args: [...CallArgs]
  ) => Effect.Effect<A, Schema.SchemaError>;
  readonly executeVSCode: <C extends VscodeBuiltinCommand>(
    command: C,
    ...args: VscodeCommandArgs<C>
  ) => Effect.Effect<VscodeCommandResult<C>>;
  readonly bind: <
    CallArgs extends CommandArguments,
    HandlerArgs extends CommandArguments,
    A,
    DecodeRequirements,
  >(
    command: MarimoCommand<CallArgs, HandlerArgs, A, DecodeRequirements>,
    title: string,
    ...args: CallArgs
  ) => vscode.Command;
  readonly setContext: <K extends MarimoContextKey>(
    key: K,
    value: ContextMap[K],
  ) => Effect.Effect<void>;
  readonly register: <
    CallArgs extends CommandArguments,
    HandlerArgs extends CommandArguments,
    A,
    DecodeRequirements,
    E,
    HandlerRequirements,
  >(
    definition: CommandDefinition<
      CallArgs,
      HandlerArgs,
      A,
      DecodeRequirements,
      E,
      HandlerRequirements
    >,
  ) => Effect.Effect<
    void,
    never,
    Scope.Scope | DecodeRequirements | HandlerRequirements
  >;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/Commands",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const win = yield* Window.Service;
    const api = vscode.commands;
    const commandPubSub =
      yield* PubSub.unbounded<Result.Result<string, string>>();

    const execute = Effect.fn("Commands.execute")(function* <
      CallArgs extends CommandArguments,
      HandlerArgs extends CommandArguments,
      A,
      DecodeRequirements,
    >(
      command: MarimoCommand<CallArgs, HandlerArgs, A, DecodeRequirements>,
      ...args: CallArgs
    ) {
      const result = yield* Effect.promise(() =>
        api.executeCommand(commandId(command), ...args),
      );
      return yield* decodeCommandResult(command, result);
    });

    const executeVSCode = Effect.fn("Commands.executeVSCode")(function* <
      C extends VscodeBuiltinCommand,
    >(command: C, ...args: VscodeCommandArgs<C>) {
      return yield* Effect.promise(() =>
        api.executeCommand<VscodeCommandResult<C>>(command, ...args),
      );
    });

    function registerImplementation<A, E, R>(
      wireId: string,
      invoke: (args: ReadonlyArray<unknown>) => Effect.Effect<A, E, R>,
    ) {
      return Effect.gen(function* () {
        const runPromise = Effect.runPromiseWith(yield* Effect.context<R>());
        const callback = (...args: unknown[]) =>
          invoke(args).pipe(
            Effect.tap(() =>
              PubSub.publish(commandPubSub, Result.succeed(wireId)),
            ),
            Effect.catchCause(
              Effect.fn(function* (cause) {
                if (isExpectedCancellation(cause)) {
                  yield* PubSub.publish(commandPubSub, Result.fail(wireId));
                  return;
                }
                yield* PubSub.publish(commandPubSub, Result.fail(wireId));
                yield* win.showWarningMessage(
                  `Something went wrong in ${JSON.stringify(wireId)}. See marimo logs for more info.`,
                );
              }),
            ),
            runPromise,
          );

        yield* acquireDisposable(() => api.registerCommand(wireId, callback));
      });
    }

    const register = Effect.fn("Commands.register")(function* <
      CallArgs extends CommandArguments,
      HandlerArgs extends CommandArguments,
      A,
      DecodeRequirements,
      E,
      HandlerRequirements,
    >(
      definition: CommandDefinition<
        CallArgs,
        HandlerArgs,
        A,
        DecodeRequirements,
        E,
        HandlerRequirements
      >,
    ) {
      const { command, invoke } = definition;
      const wireId = commandId(command);
      yield* registerImplementation(wireId, (args) =>
        Effect.gen(function* () {
          const decoded = yield* decodeCommandArguments(command, args);
          const result = yield* invoke(...decoded);
          return yield* decodeCommandResult(command, result);
        }).pipe(withCommandContext(command)),
      );
    });

    const setContext = Effect.fn("Commands.setContext")(function* <
      K extends MarimoContextKey,
    >(key: K, value: ContextMap[K]) {
      yield* Effect.promise(() => api.executeCommand("setContext", key, value));
    });

    function bind<
      CallArgs extends CommandArguments,
      HandlerArgs extends CommandArguments,
      A,
      DecodeRequirements,
    >(
      command: MarimoCommand<CallArgs, HandlerArgs, A, DecodeRequirements>,
      title: string,
      ...args: CallArgs
    ): vscode.Command {
      return {
        command: commandId(command),
        title,
        arguments: [...args],
      };
    }

    const subscribeToCommands = PubSub.subscribe(commandPubSub);

    return Service.of({
      subscribeToCommands,
      execute,
      executeVSCode,
      bind,
      setContext,
      register,
    });
  }),
);

export const defaultLayer = layer.pipe(Layer.provide(Window.layer));
