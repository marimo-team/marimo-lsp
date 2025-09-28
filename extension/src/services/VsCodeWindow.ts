import { Data, Effect } from "effect";
import * as vscode from "vscode";

export class VsCodeWindowError extends Data.TaggedError("VsCodeWindowError")<{
  cause: unknown;
}> {}

export class VsCodeWindow extends Effect.Service<VsCodeWindow>()(
  "VsCodeWindow",
  {
    scoped: Effect.gen(function* () {
      const api = vscode.window;

      function use<T>(cb: (win: typeof api) => Thenable<T>) {
        return Effect.tryPromise({
          try: () => cb(api),
          catch: (cause) => new VsCodeWindowError({ cause }),
        });
      }
      function useInfallable<T>(cb: (win: typeof api) => Thenable<T>) {
        return Effect.promise(() => cb(api));
      }
      return {
        use,
        useInfallable,
        createOutputChannel(name: string) {
          return Effect.acquireRelease(
            Effect.sync(() => api.createOutputChannel(name, { log: true })),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
      };
    }),
  },
) {}
