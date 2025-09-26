import { Effect, Fiber, FiberSet, Layer, Stream } from "effect";
import * as vscode from "vscode";

import { MarimoLanguageClient } from "./services/MarimoLanguageClient.ts";
import { notebookType } from "./types.ts";

export const DebugAdapterLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* Effect.logInfo("Setting up debug adapter");
    const marimo = yield* MarimoLanguageClient;
    const runFork = yield* FiberSet.makeRuntime();

    const emitters = new Map<
      string,
      vscode.EventEmitter<vscode.DebugProtocolMessage>
    >();

    // no need to handle because FiberSet/Scoped takes care of cleanup
    const _fiber = marimo.streamOf("marimo/dap").pipe(
      Stream.mapEffect(
        Effect.fnUntraced(function* ({ sessionId, message }) {
          yield* Effect.logDebug("Received DAP message from LSP").pipe(
            Effect.annotateLogs({ sessionId, message }),
          );
          emitters.get(sessionId)?.fire(message);
        }),
      ),
      Stream.runDrain,
      runFork,
    );

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscode.debug.registerDebugAdapterDescriptorFactory("marimo", {
          createDebugAdapterDescriptor(session) {
            const emitter =
              emitters.get(session.id) ?? new vscode.EventEmitter();
            emitters.set(session.id, emitter);

            return new vscode.DebugAdapterInlineImplementation({
              onDidSendMessage: emitter.event,
              handleMessage(message) {
                runFork<never, void>(
                  Effect.gen(function* () {
                    yield* Effect.logDebug("Sending DAP message to LSP").pipe(
                      Effect.annotateLogs({ sessionId: session.id, message }),
                    );
                    yield* marimo.dap({
                      notebookUri: session.configuration.notebookUri,
                      inner: {
                        sessionId: session.id,
                        message,
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
        }),
      ),
      (disposer) => Effect.sync(() => disposer.dispose()),
    );

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscode.debug.registerDebugConfigurationProvider("marimo", {
          resolveDebugConfiguration(_workspaceFolder, config) {
            return runFork<never, vscode.DebugConfiguration | undefined>(
              Effect.gen(function* () {
                yield* Effect.logInfo("Resolving debug configuration").pipe(
                  Effect.annotateLogs("config", config),
                );
                const notebook = vscode.window.activeNotebookEditor?.notebook;
                if (!notebook || notebook.notebookType !== notebookType) {
                  yield* Effect.logWarning("No active marimo notebook found");
                  return undefined;
                }
                config.type = "marimo";
                config.name = config.name ?? "Debug Marimo";
                config.request = config.request ?? "launch";
                config.notebookUri = notebook.uri.toString();
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
        }),
      ),
      (disposer) => Effect.sync(() => disposer.dispose()),
    );

    yield* Effect.logInfo("Debug adapter initialized");
    yield* Effect.addFinalizer(() =>
      Effect.logInfo("Tearing down debug adapter"),
    );
  }),
);
