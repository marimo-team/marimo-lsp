import { Effect, ParseResult, Schema } from "effect";
import type * as vscode from "vscode";

import builtinCommandCatalog from "../builtin-command-catalog.json";

const MarimoCommandTypeId: unique symbol = Symbol("MarimoCommand");

export type CommandArguments = ReadonlyArray<unknown>;

export interface CommandInvocation<
  CallArgs extends CommandArguments,
  HandlerArgs extends CommandArguments,
  Requirements = never,
> {
  readonly callArguments?: CallArgs;
  readonly contributedSurfaces: ReadonlyArray<string>;
  readonly decode: (
    args: ReadonlyArray<unknown>,
  ) => Effect.Effect<HandlerArgs, SchemaError.SchemaError, Requirements>;
}

export interface MarimoCommand<
  CallArgs extends CommandArguments = CommandArguments,
  HandlerArgs extends CommandArguments = CommandArguments,
  Result = unknown,
  DecodeRequirements = unknown,
> {
  readonly [MarimoCommandTypeId]: {
    readonly callArguments?: CallArgs;
    readonly id: string;
    readonly contributedSurfaces: ReadonlyArray<string>;
    readonly decodeArguments: (
      args: ReadonlyArray<unknown>,
    ) => Effect.Effect<HandlerArgs, SchemaError.SchemaError, DecodeRequirements>;
    readonly decodeResult: (
      result: unknown,
    ) => Effect.Effect<Result, SchemaError.SchemaError>;
  };
}

export interface CommandDefinition<
  CallArgs extends CommandArguments,
  HandlerArgs extends CommandArguments,
  Result,
  DecodeRequirements,
  HandlerError,
  HandlerRequirements,
> {
  readonly command: MarimoCommand<
    CallArgs,
    HandlerArgs,
    Result,
    DecodeRequirements
  >;
  /**
   * Run the command operation with arguments already normalized by its
   * invocation adapter.
   */
  readonly invoke: (
    ...args: HandlerArgs
  ) => Effect.Effect<Result, HandlerError, HandlerRequirements>;
}

export function defineCommand<
  CallArgs extends CommandArguments,
  HandlerArgs extends CommandArguments,
  Result,
  DecodeRequirements,
  HandlerError,
  HandlerRequirements,
>(
  command: MarimoCommand<CallArgs, HandlerArgs, Result, DecodeRequirements>,
  operation: (
    ...args: HandlerArgs
  ) => Effect.Effect<Result, HandlerError, HandlerRequirements>,
): CommandDefinition<
  CallArgs,
  HandlerArgs,
  Result,
  DecodeRequirements,
  HandlerError,
  HandlerRequirements
> {
  const wireId = commandId(command);
  const invoke = (...args: HandlerArgs) =>
    operation(...args).pipe(
      Effect.withSpan("command", {
        attributes: { "command.id": wireId },
      }),
      Effect.annotateLogs({ "command.id": wireId }),
    );
  return { command, invoke };
}

export function marimoCommand<
  CallArgs extends CommandArguments,
  HandlerArgs extends CommandArguments,
  Result,
  ResultEncoded,
  DecodeRequirements,
>(
  id: string,
  invocation: CommandInvocation<CallArgs, HandlerArgs, DecodeRequirements>,
  result: Schema.Schema<Result, ResultEncoded>,
): MarimoCommand<CallArgs, HandlerArgs, Result, DecodeRequirements> {
  return {
    [MarimoCommandTypeId]: {
      id,
      contributedSurfaces: invocation.contributedSurfaces,
      decodeArguments: invocation.decode,
      decodeResult: Schema.decodeUnknown(result),
    },
  };
}

export const VscodeUriSchema = Schema.declare<vscode.Uri>(
  (value): value is vscode.Uri =>
    typeof value === "object" &&
    value !== null &&
    "scheme" in value &&
    typeof value.scheme === "string" &&
    "path" in value &&
    typeof value.path === "string" &&
    "with" in value &&
    typeof value.with === "function" &&
    "toString" in value &&
    typeof value.toString === "function",
  { identifier: "vscode.Uri" },
);

export function commandId(command: MarimoCommand): string {
  return command[MarimoCommandTypeId].id;
}

export function commandContributedSurfaces(
  command: MarimoCommand,
): ReadonlyArray<string> {
  return command[MarimoCommandTypeId].contributedSurfaces;
}

export function decodeCommandArguments<
  CallArgs extends CommandArguments,
  HandlerArgs extends CommandArguments,
  Result,
  DecodeRequirements,
>(
  command: MarimoCommand<CallArgs, HandlerArgs, Result, DecodeRequirements>,
  args: ReadonlyArray<unknown>,
): Effect.Effect<HandlerArgs, SchemaError.SchemaError, DecodeRequirements> {
  return command[MarimoCommandTypeId].decodeArguments(args);
}

export function decodeCommandResult<
  CallArgs extends CommandArguments,
  HandlerArgs extends CommandArguments,
  Result,
  DecodeRequirements,
>(
  command: MarimoCommand<CallArgs, HandlerArgs, Result, DecodeRequirements>,
  result: unknown,
): Effect.Effect<Result, SchemaError.SchemaError> {
  return command[MarimoCommandTypeId].decodeResult(result);
}

export type CommandCallArgs<C extends MarimoCommand> =
  C extends MarimoCommand<infer Args, infer _Handler, infer _Result, infer _R>
    ? Args
    : never;

export type CommandHandlerArgs<C extends MarimoCommand> =
  C extends MarimoCommand<infer _Call, infer Args, infer _Result, infer _R>
    ? Args
    : never;

export type CommandResult<C extends MarimoCommand> =
  C extends MarimoCommand<infer _Call, infer _Handler, infer Result, infer _R>
    ? Result
    : never;

type NotebookCellRange = {
  readonly start: number;
  readonly end: number;
};

type NotebookCellCommandTarget = {
  readonly ranges: ReadonlyArray<NotebookCellRange>;
  readonly document?: vscode.Uri;
};

/**
 * Built-in commands the extension actually executes.
 *
 * VS Code exposes `executeCommand` as a string plus `any[]`; it does not
 * publish a machine-readable signature registry. Keep this small catalog
 * aligned with the call sites and verify its enumerable IDs against VS Code
 * in the extension integration suite. `vscode.openWith` is executable but is
 * not returned by `commands.getCommands()`.
 */
export interface VscodeCommandMap {
  readonly "notebook.cell.collapseCellInput": {
    readonly args: [target: NotebookCellCommandTarget];
    readonly result: void;
  };
  readonly "notebook.cell.execute": {
    readonly args: [target: NotebookCellCommandTarget];
    readonly result: void;
  };
  readonly "notebook.cell.expandCellInput": {
    readonly args: [target: NotebookCellCommandTarget];
    readonly result: void;
  };
  readonly "outline.focus": {
    readonly args: [];
    readonly result: void;
  };
  readonly "vscode.openWith": {
    readonly args: [resource: vscode.Uri, viewId: string];
    readonly result: void;
  };
  readonly "workbench.action.openSettings": {
    readonly args: [query?: string];
    readonly result: void;
  };
  readonly "workbench.action.reloadWindow": {
    readonly args: [];
    readonly result: void;
  };
}

export const VscodeBuiltinCommandCatalog = builtinCommandCatalog;
export type VscodeBuiltinCommand = keyof typeof VscodeBuiltinCommandCatalog;
export type VscodeCommandArgs<C extends VscodeBuiltinCommand> =
  VscodeCommandMap[C]["args"];
export type VscodeCommandResult<C extends VscodeBuiltinCommand> =
  VscodeCommandMap[C]["result"];
