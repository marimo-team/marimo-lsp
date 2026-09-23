import { Context, Data, Effect, Exit, Layer, Option, Scope } from "effect";
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";

import { acquireDisposable } from "../lib/acquireDisposable.ts";

export class Error extends Data.TaggedError("Debug.Error")<{
  readonly cause: unknown;
}> {}

export class SessionStartError extends Data.TaggedError(
  "Debug.SessionStartError",
)<{
  readonly configuration: string | vscode.DebugConfiguration;
}> {}

export interface AdapterFactory<R = never> {
  readonly createDebugAdapter: (
    session: vscode.DebugSession,
    executable: vscode.DebugAdapterExecutable | undefined,
  ) => Effect.Effect<
    Option.Option<Omit<vscode.DebugAdapter, "dispose">>,
    never,
    Scope.Scope | R
  >;
}

export interface Interface {
  readonly registerDebugConfigurationProvider: (
    debugType: string,
    factory: vscode.DebugConfigurationProvider,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly registerDebugAdapterDescriptorFactory: <R = never>(
    debugType: string,
    factory: AdapterFactory<R>,
  ) => Effect.Effect<void, never, Scope.Scope | R>;
  readonly startDebugging: (
    folder: vscode.WorkspaceFolder | undefined,
    nameOrConfiguration: string | vscode.DebugConfiguration,
  ) => Effect.Effect<void, Error | SessionStartError>;
  readonly stopDebugging: (sessionId?: string) => Effect.Effect<void>;
  readonly onDidTerminateDebugSession: (
    listener: (session: vscode.DebugSession) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/Debug",
) {}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const api = vscode.debug;

    const registerDebugConfigurationProvider = Effect.fn(
      "Debug.registerDebugConfigurationProvider",
    )(function* (
      debugType: string,
      factory: vscode.DebugConfigurationProvider,
    ) {
      yield* acquireDisposable(() =>
        api.registerDebugConfigurationProvider(debugType, factory),
      );
    });

    const registerDebugAdapterDescriptorFactory = Effect.fn(
      "Debug.registerDebugAdapterDescriptorFactory",
    )(function* <R = never>(debugType: string, factory: AdapterFactory<R>) {
      const context = yield* Effect.context<R>();
      const runPromise = Effect.runPromiseWith(context);
      const runFork = Effect.runForkWith(context);

      yield* acquireDisposable(() =>
        api.registerDebugAdapterDescriptorFactory(debugType, {
          createDebugAdapterDescriptor: (session, executable) =>
            runPromise(
              Effect.gen(function* () {
                const scope = yield* Scope.make();
                const adapter = yield* factory
                  .createDebugAdapter(session, executable)
                  .pipe(Scope.provide(scope));

                if (Option.isNone(adapter)) {
                  yield* Scope.close(scope, Exit.void);
                  return null;
                }

                return new vscode.DebugAdapterInlineImplementation(
                  Object.assign(adapter.value, {
                    dispose: () => runFork(Scope.close(scope, Exit.void)),
                  }),
                );
              }),
            ),
        }),
      );
    });

    const startDebugging = Effect.fn("Debug.startDebugging")(function* (
      folder: vscode.WorkspaceFolder | undefined,
      nameOrConfiguration: string | vscode.DebugConfiguration,
    ) {
      yield* Effect.tryPromise({
        try: () => api.startDebugging(folder, nameOrConfiguration),
        catch: (cause) => new Error({ cause }),
      }).pipe(
        Effect.filterOrFail(
          (success) => success,
          () => new SessionStartError({ configuration: nameOrConfiguration }),
        ),
        Effect.asVoid,
      );
    });

    const stopDebugging = Effect.fn("Debug.stopDebugging")(function* (
      sessionId?: string,
    ) {
      const session = api.activeDebugSession;
      if (sessionId !== undefined && session?.id !== sessionId) return;
      yield* Effect.promise(() => api.stopDebugging(session));
    });

    const onDidTerminateDebugSession = Effect.fn(
      "Debug.onDidTerminateDebugSession",
    )(function* (
      listener: (session: vscode.DebugSession) => Effect.Effect<void>,
    ) {
      const runPromise = Effect.runPromiseWith(yield* Effect.context());
      yield* acquireDisposable(() =>
        api.onDidTerminateDebugSession((session) => {
          void runPromise(listener(session));
        }),
      );
    });

    return Service.of({
      registerDebugConfigurationProvider,
      registerDebugAdapterDescriptorFactory,
      startDebugging,
      stopDebugging,
      onDidTerminateDebugSession,
    });
  }),
);
