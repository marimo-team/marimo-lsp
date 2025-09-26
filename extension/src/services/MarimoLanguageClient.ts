import { Data, Effect, type ParseResult, Schema, Stream } from "effect";
import * as vscode from "vscode";
import { executeCommand } from "../commands.ts";
import { NotebookSerializationSchema } from "../schemas.ts";
import type {
  MarimoCommand,
  MarimoNotification,
  MarimoNotificationOf,
} from "../types.ts";
import { BaseLanguageClient } from "./BaseLanguageClient.ts";

export class MarimoLanguageClient extends Effect.Service<MarimoLanguageClient>()(
  "MarimoLanguageClient",
  {
    effect: Effect.gen(function* () {
      const client = yield* BaseLanguageClient;

      function exec(command: MarimoCommand) {
        return Effect.withSpan(command.command)(
          Effect.tryPromise({
            try: (signal) => {
              const source = new vscode.CancellationTokenSource();
              if (signal.aborted) {
                source.cancel();
              }
              signal.addEventListener("abort", () => {
                source.cancel();
              });
              return executeCommand(client, {
                ...command,
                token: source.token,
              }).finally(() => {
                source.dispose();
              });
            },
            catch: (error) => new ExecuteCommandError({ command, error }),
          }),
        );
      }

      return {
        client,
        run(params: ParamsFor<"marimo.run">) {
          return exec({ command: "marimo.run", params });
        },
        setUiElementValue(params: ParamsFor<"marimo.set_ui_element_value">) {
          return exec({ command: "marimo.set_ui_element_value", params });
        },
        interrupt(params: ParamsFor<"marimo.interrupt">) {
          return exec({ command: "marimo.interrupt", params });
        },
        dap(params: ParamsFor<"marimo.dap">) {
          return exec({ command: "marimo.dap", params });
        },
        serialize(
          params: vscode.NotebookData,
        ): Effect.Effect<
          Uint8Array,
          ExecuteCommandError | ParseResult.ParseError,
          never
        > {
          const { cells, metadata = {} } = params;
          return Effect.gen(function* () {
            const notebook = yield* Schema.decodeUnknown(
              NotebookSerializationSchema,
            )({
              app: metadata.app ?? { options: {} },
              header: metadata.header ?? null,
              version: metadata.version ?? null,
              violations: metadata.violations ?? [],
              valid: metadata.valid ?? true,
              cells: cells.map((cell) => ({
                code: cell.value,
                name: cell.metadata?.name ?? "_",
                options: cell.metadata?.options ?? {},
              })),
            });
            return yield* exec({
              command: "marimo.serialize",
              params: { notebook },
            }).pipe(
              Effect.andThen(
                Schema.decodeUnknown(Schema.Struct({ source: Schema.String })),
              ),
              Effect.andThen(({ source }) => new TextEncoder().encode(source)),
            );
          });
        },
        deserialize(
          buf: Uint8Array,
        ): Effect.Effect<
          vscode.NotebookData,
          ExecuteCommandError | ParseResult.ParseError,
          never
        > {
          return exec({
            command: "marimo.deserialize",
            params: { source: new TextDecoder().decode(buf) },
          }).pipe(
            Effect.andThen(Schema.decodeUnknown(NotebookSerializationSchema)),
            Effect.andThen(({ cells, ...metadata }) => ({
              metadata: metadata,
              cells: cells.map((cell) => ({
                kind: vscode.NotebookCellKind.Code,
                value: cell.code,
                languageId: "python",
                metadata: {
                  name: cell.name,
                  options: cell.options,
                },
              })),
            })),
          );
        },
        streamOf<Notification extends MarimoNotification>(
          notification: Notification,
        ): Stream.Stream<MarimoNotificationOf<Notification>, never, never> {
          return Stream.asyncPush((emit) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                client.onNotification(notification, emit.single.bind(emit)),
              ),
              (disposable) => Effect.sync(() => disposable.dispose()),
            ),
          );
        },
      };
    }),
  },
) {}

type ParamsFor<Command extends MarimoCommand["command"]> = Extract<
  MarimoCommand,
  { command: Command }
>["params"];

class ExecuteCommandError extends Data.TaggedError("ExecuteCommandError")<{
  readonly command: MarimoCommand;
  readonly error: unknown;
}> {}
