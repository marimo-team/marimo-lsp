import { Effect, type ParseResult, Schema, Stream } from "effect";
import * as vscode from "vscode";
import { NotebookSerializationSchema } from "../schemas.ts";
import type {
  MarimoCommand,
  MarimoNotification,
  MarimoNotificationOf,
} from "../types.ts";
import {
  BaseLanguageClient,
  type ExecuteCommandError,
} from "./BaseLanguageClient.ts";

export class MarimoLanguageClient extends Effect.Service<MarimoLanguageClient>()(
  "MarimoLanguageClient",
  {
    effect: Effect.gen(function* () {
      const client = yield* BaseLanguageClient;

      return {
        client,
        run(params: ParamsFor<"marimo.run">) {
          return client.executeCommand({ command: "marimo.run", params });
        },
        setUiElementValue(params: ParamsFor<"marimo.set_ui_element_value">) {
          return client.executeCommand({
            command: "marimo.set_ui_element_value",
            params,
          });
        },
        interrupt(params: ParamsFor<"marimo.interrupt">) {
          return client.executeCommand({ command: "marimo.interrupt", params });
        },
        dap(params: ParamsFor<"marimo.dap">) {
          return client.executeCommand({ command: "marimo.dap", params });
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
            return yield* client
              .executeCommand({
                command: "marimo.serialize",
                params: { notebook },
              })
              .pipe(
                Effect.andThen(
                  Schema.decodeUnknown(
                    Schema.Struct({ source: Schema.String }),
                  ),
                ),
                Effect.andThen(({ source }) =>
                  new TextEncoder().encode(source),
                ),
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
          return client
            .executeCommand({
              command: "marimo.deserialize",
              params: { source: new TextDecoder().decode(buf) },
            })
            .pipe(
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
