import { Effect, Fiber, FiberSet } from "effect";
import * as vscode from "vscode";

import { LanguageClient } from "./LanguageClient.ts";
import { NotebookSerializer } from "./NotebookSerializer.ts";

/**
 * Provides Debug Adapter Protocol (DAP) bridge for marimo notebooks.
 */
export class DebugAdapter extends Effect.Service<DebugAdapter>()(
  "DebugAdapter",
  {
    dependencies: [NotebookSerializer.Default, LanguageClient.Default],
    scoped: Effect.gen(function* () {
      const debugType = "marimo";
      const serializer = yield* NotebookSerializer;
      const marimo = yield* LanguageClient;
      const runFork = yield* FiberSet.makeRuntime();

      yield* Effect.logInfo("Setting up debug adapter").pipe(
        Effect.annotateLogs({ component: "debug-adapter" }),
      );

      const emitters = new Map<
        string,
        vscode.EventEmitter<vscode.DebugProtocolMessage>
      >();

      yield* marimo.onNotification("marimo/dap", ({ sessionId, message }) =>
        runFork(
          Effect.gen(function* () {
            yield* Effect.logDebug("Received DAP message from LSP").pipe(
              Effect.annotateLogs({
                component: "debug-adapter",
                sessionId,
                // @ts-expect-error - type is not include in vscode types
                type: message.type,
              }),
            );
            emitters.get(sessionId)?.fire(message);
          }),
        ),
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
                        Effect.annotateLogs({
                          component: "debug-adapter",
                          sessionId: session.id,
                          // @ts-expect-error - type is not include in vscode types
                          type: message.type,
                        }),
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
                    Effect.annotateLogs({
                      component: "debug-adapter",
                      config,
                    }),
                  );
                  const notebook = vscode.window.activeNotebookEditor?.notebook;
                  if (notebook?.notebookType !== serializer.notebookType) {
                    yield* Effect.logWarning(
                      "No active marimo notebook found",
                    ).pipe(Effect.annotateLogs({ component: "debug-adapter" }));
                    return undefined;
                  }
                  config.type = "marimo";
                  config.name = config.name ?? "Debug Marimo";
                  config.request = config.request ?? "launch";
                  config.notebookUri = notebook.uri.toString();
                  yield* Effect.logInfo("Configuration resolved").pipe(
                    Effect.annotateLogs({
                      component: "debug-adapter",
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

      yield* Effect.logInfo("Debug adapter initialized").pipe(
        Effect.annotateLogs({ component: "debug-adapter" }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.logInfo("Tearing down debug adapter").pipe(
          Effect.annotateLogs({ component: "debug-adapter" }),
        ),
      );

      return { debugType };
    }),
  },
) {}
