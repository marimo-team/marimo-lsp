import { Effect } from "effect";
import type { Uv } from "../services/Uv";
import type { VsCode } from "../services/VsCode";

export const installPackages = (
  venv: string,
  packages: ReadonlyArray<string>,
  { uv, code }: { uv: Uv; code: VsCode },
) =>
  code.window.withProgress(
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
          code.window.showErrorMessage(
            `Failed to install ${packages.join(", ")}. See marimo logs for details.`,
          ),
        ),
      ),
  );
