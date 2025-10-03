import { Effect, Fiber, FiberSet, Option, Stream } from "effect";
import type * as vscode from "vscode";

import { LanguageClient } from "./LanguageClient.ts";
import { NotebookSerializer } from "./NotebookSerializer.ts";
import { VsCode } from "./VsCode.ts";

/**
 * Provides Debug Adapter Protocol (DAP) bridge for marimo notebooks.
 */
export class DebugAdapter extends Effect.Service<DebugAdapter>()(
  "DebugAdapter",
  {
    dependencies: [
      NotebookSerializer.Default,
      LanguageClient.Default,
      VsCode.Default,
    ],
    scoped: Effect.gen(function* () {
      const debugType = "marimo";

      const code = yield* VsCode;
      const client = yield* LanguageClient;
      const serializer = yield* NotebookSerializer;

      const runFork = yield* FiberSet.makeRuntime();

      const emitters = new Map<
        string,
        vscode.EventEmitter<vscode.DebugProtocolMessage>
      >();

      yield* client.streamOf("marimo/dap").pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* ({ sessionId, message }) {
            yield* Effect.logDebug("Received DAP message from LSP").pipe(
              Effect.annotateLogs({
                sessionId,
                // @ts-expect-error - type is not include in vscode types
                type: message.type,
              }),
            );
            emitters.get(sessionId)?.fire(message);
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );

      yield* code.debug.registerDebugAdapterDescriptorFactory(debugType, {
        createDebugAdapterDescriptor(session) {
          const emitter = emitters.get(session.id) ?? new code.EventEmitter();
          emitters.set(session.id, emitter);

          return new code.DebugAdapterInlineImplementation({
            onDidSendMessage: emitter.event,
            handleMessage(message) {
              runFork<never, void>(
                Effect.gen(function* () {
                  yield* Effect.logDebug("Sending DAP message to LSP").pipe(
                    Effect.annotateLogs({
                      sessionId: session.id,
                      // @ts-expect-error - type is not include in vscode types
                      type: message.type,
                    }),
                  );
                  yield* client.executeCommand({
                    command: "marimo.dap",
                    params: {
                      notebookUri: session.configuration.notebookUri,
                      inner: {
                        sessionId: session.id,
                        message,
                      },
                    },
                  });
                }).pipe(
                  Effect.catchTags({
                    ExecuteCommandError: Effect.logError,
                  }),
                ),
              );
            },
            dispose() {
              emitters.get(session.id)?.dispose();
              emitters.delete(session.id);
            },
          });
        },
      });

      yield* code.debug.registerDebugConfigurationProvider(debugType, {
        resolveDebugConfiguration(_workspaceFolder, config) {
          return runFork<never, vscode.DebugConfiguration | undefined>(
            Effect.gen(function* () {
              yield* Effect.logInfo("Resolving debug configuration").pipe(
                Effect.annotateLogs({ config }),
              );
              const notebook = code.window
                .getActiveNotebookEditor()
                .pipe(
                  Option.flatMap((editor) =>
                    serializer.isMarimoNotebookDocument(editor.notebook)
                      ? Option.some(editor.notebook)
                      : Option.none(),
                  ),
                );
              if (Option.isNone(notebook)) {
                yield* Effect.logWarning("No active marimo notebook found");
                return undefined;
              }
              config.type = "marimo";
              config.name = config.name ?? "Debug Marimo";
              config.request = config.request ?? "launch";
              config.notebookUri = notebook.value.uri.toString();
              yield* Effect.logInfo("Configuration resolved").pipe(
                Effect.annotateLogs({
                  notebookUri: config.notebookUri,
                  type: config.type,
                  request: config.request,
                }),
              );
              return config;
            }),
          ).pipe(Fiber.join, Effect.runPromise);
        },
      });

      return { debugType };
    }),
  },
) {}
