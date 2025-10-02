import { Effect } from "effect";
import type * as vscode from "vscode";
import type { Uv } from "../services/Uv";
import type { VsCode } from "../services/VsCode";

function withProgress(
  code: VsCode,
  options: {
    location: vscode.ProgressLocation;
    title: string;
    cancellable: boolean;
  },
  factory: (
    progress: vscode.Progress<{
      readonly message: string;
      readonly increment?: number;
    }>,
  ) => Effect.Effect<void, never, never>,
) {
  const outer = Promise.withResolvers<void>();
  const inner =
    Promise.withResolvers<
      vscode.Progress<{
        readonly message: string;
        readonly increment?: number;
      }>
    >();

  return Effect.gen(function* () {
    const { progress, finished } = yield* code.window.useInfallible(
      async (api) => {
        const handle = api.withProgress(options, (task) => {
          inner.resolve(task);
          return outer.promise;
        });
        return inner.promise.then((progress) => ({
          progress,
          finished: Effect.promise(() => handle),
        }));
      },
    );

    // run the work
    yield* factory(progress);

    // ✅ allow the UI to close
    outer.resolve();

    // wait for VS Code to finish closing the UI
    yield* finished;
  });
}

export const installPackages = (
  venv: string,
  packages: ReadonlyArray<string>,
  { uv, code }: { uv: Uv; code: VsCode },
) =>
  withProgress(
    code,
    {
      location: code.ProcessLocation.Notification,
      title: `Installing ${packages.length > 1 ? "packages" : "package"}`,
      cancellable: true,
    },
    (progress) =>
      Effect.gen(function* () {
        progress.report({
          message: `Installing ${packages.join(", ")}...`,
        });
        yield* Effect.logDebug("Attempting `uv add`.").pipe(
          Effect.annotateLogs({ packages, directory: venv }),
        );
        yield* uv.add(packages, { directory: venv }).pipe(
          Effect.catchTag(
            "MissingPyProjectError",
            Effect.fnUntraced(function* () {
              yield* Effect.logWarning(
                "Failed to `uv add`, attempting `uv pip install`.",
              );
              yield* uv.pipInstall(packages, { venv });
            }),
          ),
        );
        progress.report({
          message: `Successfully installed ${packages.join(", ")}`,
        });
      }).pipe(
        Effect.tapError(Effect.logError),
        Effect.catchAllCause((_) =>
          code.window.useInfallible((api) =>
            api.showErrorMessage(
              `Failed to install ${packages.join(", ")}. See marimo logs for details.`,
            ),
          ),
        ),
      ),
  );
