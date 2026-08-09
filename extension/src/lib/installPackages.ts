import * as NodeFs from "node:fs";

import { Cause, Data, Effect, Option } from "effect";

import { assert } from "../assert.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  formatProjectDependencyTarget,
  inspectProjectDependencies,
  ProjectDependencyTarget,
} from "../python/ProjectDependencyTarget.ts";
import { Uv, UvUnknownError } from "../python/Uv.ts";
import type { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";

export function installPackages(
  packages: ReadonlyArray<string>,
  options: {
    venvPath: string;
  },
): Effect.Effect<InstallPackagesOutcome, never, Uv | VsCode>;
export function installPackages(
  packages: ReadonlyArray<string>,
  options: {
    script: MarimoNotebookDocument;
  },
): Effect.Effect<InstallPackagesOutcome, never, Uv | VsCode>;
export function installPackages(
  packages: ReadonlyArray<string>,
  options: {
    script?: MarimoNotebookDocument;
    venvPath?: string;
  },
): Effect.Effect<InstallPackagesOutcome, never, Uv | VsCode> {
  return Effect.gen(function* () {
    const uv = yield* Uv;
    const code = yield* VsCode;
    return yield* code.window.withProgress(
      {
        location: code.ProgressLocation.Notification,
        title: `Installing ${packages.length > 1 ? "packages" : "package"}`,
        cancellable: true,
      },
      (progress) =>
        Effect.gen(function* () {
          progress.report({
            message: `Installing ${packages.join(", ")}...`,
          });

          if (options.venvPath) {
            const venvPath = options.venvPath;
            const requests = yield* resolveProjectInstallRequests(
              packages,
              venvPath,
            ).pipe(Effect.provideService(VsCode, code));
            if (requests == null) return "cancelled" as const;

            for (const request of requests) {
              yield* uv
                .addProject({
                  directory: venvPath,
                  packages: request.packages,
                  target: request.target,
                })
                .pipe(
                  Effect.catchTag(
                    "UvMissingPyProjectError",
                    Effect.fn(function* () {
                      yield* Effect.logWarning(
                        "Failed to `uv add`, attempting `uv pip install`.",
                      );
                      yield* uv.pipInstall(request.packages, {
                        venv: venvPath,
                      });
                    }),
                  ),
                );
            }
          } else {
            const notebook = options.script;
            assert(notebook, "Expected notebook");

            // safely update the the notebook
            yield* uvAddScriptSafe(packages, notebook).pipe(
              Effect.provideService(VsCode, code),
              Effect.provideService(Uv, uv),
            );

            // sync the virtual env
            yield* uv.syncScript({ script: notebook.uri.fsPath }).pipe(
              // Should be added by `uvAddScriptSafe`
              Effect.catchTag("UvMissingPep723MetadataError", () =>
                Effect.die("Expected PEP 723 metadata to be present"),
              ),
            );
          }
          progress.report({
            message: `Successfully installed ${packages.join(", ")}`,
          });
          return "installed" as const;
        }).pipe(
          Effect.catchAllCause(
            Effect.fn(function* (cause) {
              yield* Effect.logError("Failed to install").pipe(
                Effect.annotateLogs({ cause }),
              );

              // Extract actionable detail from the uv error, if available
              const detail = extractUvErrorDetail(cause);
              const suffix = detail
                ? `\n\n${detail}`
                : " See marimo logs for details.";

              yield* code.window.showErrorMessage(
                `Failed to install ${packages.join(", ")}.${suffix}`,
              );
              return "failed" as const;
            }),
          ),
        ),
    );
  });
}

export type InstallPackagesOutcome = "installed" | "cancelled" | "failed";

export type ProjectInstallRequest = {
  readonly packages: ReadonlyArray<string>;
  readonly target: ProjectDependencyTarget;
};

class ProjectInspectionError extends Data.TaggedError(
  "ProjectInspectionError",
)<{
  readonly cause: unknown;
}> {}

export const resolveProjectInstallRequests = Effect.fn(
  "resolveProjectInstallRequests",
)(function* (packages: ReadonlyArray<string>, directory: string) {
  const code = yield* VsCode;
  const requests: ProjectInstallRequest[] = [];

  const inspection = yield* Effect.try({
    try: () => inspectProjectDependencies(directory),
    catch: (cause) => new ProjectInspectionError({ cause }),
  }).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning(
        "Failed to inspect pyproject.toml; using project dependencies",
      ).pipe(Effect.annotateLogs({ cause })),
    ),
    Effect.option,
  );

  for (const pkg of packages) {
    const targets = Option.match(inspection, {
      onNone: () => [],
      onSome: (index) => index.findTargets(pkg),
    });

    const hasDuplicateDevDeclaration =
      Option.isSome(inspection) &&
      inspection.value.hasDuplicateDevDeclaration(pkg);
    if (hasDuplicateDevDeclaration || targets.length > 1) {
      const locations = targets.map(formatProjectDependencyTarget).join(", ");
      const legacyLocation = hasDuplicateDevDeclaration
        ? `${locations.length > 0 ? ", " : ""}Legacy uv dev dependencies`
        : "";
      yield* code.window.showErrorMessage(
        `${pkg} is declared in multiple locations (${locations}${legacyLocation}). uv cannot safely update only one declaration because the remaining constraint may prevent resolution. Consolidate or update the declarations in pyproject.toml manually.`,
      );
      return null;
    }

    let target: ProjectDependencyTarget;
    if (targets.length === 0) {
      target = ProjectDependencyTarget.Production();
    } else {
      const [onlyTarget] = targets;
      assert(onlyTarget, "Expected one project dependency target");
      target = onlyTarget;
    }

    const existing = requests.find((request) =>
      dependencyTargetsEqual(request.target, target),
    );
    if (existing == null) {
      requests.push({ packages: [pkg], target });
    } else {
      requests[requests.indexOf(existing)] = {
        ...existing,
        packages: [...existing.packages, pkg],
      };
    }
  }

  return requests;
});

function dependencyTargetsEqual(
  left: ProjectDependencyTarget,
  right: ProjectDependencyTarget,
): boolean {
  if (left._tag !== right._tag) {
    return false;
  }
  return ProjectDependencyTarget.$match(left, {
    Production: () => true,
    Group: ({ name }) => right._tag === "Group" && name == right.name,
    Optional: ({ name }) => right._tag === "Optional" && name == right.name,
  });
}

export const uvAddScriptSafe = Effect.fn("uvAddScriptSafe")(function* (
  packages: ReadonlyArray<string>,
  notebook: MarimoNotebookDocument,
) {
  const uv = yield* Uv;
  const code = yield* VsCode;
  const tmpFile = `${notebook.uri.fsPath}.tmp`;
  const metadata = yield* notebook.parseMetadata();
  yield* Effect.promise(() =>
    NodeFs.promises.writeFile(tmpFile, metadata.header ?? ""),
  );

  yield* uv.addScript({ script: tmpFile, packages, noSync: true });

  const newHeader = yield* Effect.promise(async () =>
    NodeFs.promises.readFile(tmpFile, "utf-8"),
  );

  yield* Effect.promise(async () => NodeFs.promises.unlink(tmpFile));

  {
    yield* Effect.sleep("10 millis");
    const docs = yield* code.workspace.getNotebookDocuments();
    const doc = docs.find(
      (nb) => nb.uri.toString() === notebook.uri.toString(),
    );
    assert(doc, "no notebook");

    const nextMetadata = notebook.buildMetadataUpdate({
      header: newHeader,
    });
    if (nextMetadata !== doc.metadata) {
      const edit = new code.WorkspaceEdit();
      edit.set(doc.uri, [
        code.NotebookEdit.updateNotebookMetadata(nextMetadata),
      ]);
      yield* code.workspace.applyEdit(edit);
    }
  }

  {
    yield* Effect.sleep("10 millis");
    const docs = yield* code.workspace.getNotebookDocuments();
    const doc = docs.find(
      (nb) => nb.uri.toString() === notebook.uri.toString(),
    );
    assert(doc, "no notebook");
    yield* Effect.promise(() => doc.save());
  }
});

/**
 * Walk the Cause tree looking for a UvUnknownError and return the last
 * line of its stderr (typically the most actionable message).
 */
function extractUvErrorDetail(cause: Cause.Cause<unknown>): string | null {
  const failures = Cause.failures(cause);
  for (const failure of failures) {
    if (failure instanceof UvUnknownError && failure.stderr) {
      const lines = failure.stderr.trim().split("\n");
      return lines[lines.length - 1] ?? null;
    }
  }
  return null;
}
