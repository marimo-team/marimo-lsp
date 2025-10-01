import * as semver from "@std/semver";
import { type Brand, Effect, Either, HashMap, Option } from "effect";
import type * as vscode from "vscode";
import { assert } from "./assert.ts";
import type { LanguageClient } from "./services/LanguageClient.ts";
import type { NotebookRenderer } from "./services/NotebookRenderer.ts";
import type { PyPiClient } from "./services/PyPIClient.ts";
import type { VsCode } from "./services/VsCode.ts";
import { type CellRuntimeState, CellStateManager } from "./shared/cells.ts";
import type {
  CellMessage,
  MessageOperation,
  MessageOperationOf,
} from "./types.ts";

export interface OperationContext {
  editor: vscode.NotebookEditor;
  controller: vscode.NotebookController;
  executions: Map<string, vscode.NotebookCellExecution>;
}

export const routeOperation = Effect.fn("routeOperation")(function* (
  operation: MessageOperation,
  deps: {
    context: OperationContext;
    renderer: NotebookRenderer;
    code: VsCode;
    marimo: LanguageClient;
    pypi: PyPiClient;
  },
) {
  switch (operation.op) {
    case "cell-op": {
      yield* handleCellOperation(operation, deps);
      return;
    }
    case "installing-package-alert": {
      yield* handleInstallingPackageAlert(operation, deps);
      return;
    }
    case "missing-package-alert": {
      yield* handleMissingPackageAlert(operation, deps);
      return;
    }
    // Forward to renderer (front end)
    case "remove-ui-elements":
    case "function-call-result":
    case "send-ui-element-message": {
      yield* Effect.logTrace("Forwarding message to renderer").pipe(
        Effect.annotateLogs({ op: operation.op }),
      );
      yield* deps.renderer.postMessage(operation, deps.context.editor);
      return;
    }
    case "interrupted": {
      // Clear all pending executions when run is interrupted
      const executionCount = deps.context.executions.size;
      for (const execution of deps.context.executions.values()) {
        execution.end(false, Date.now());
      }
      deps.context.executions.clear();
      yield* Effect.logInfo("Run completed").pipe(
        Effect.annotateLogs({
          op: operation.op,
          clearedExecutions: executionCount,
        }),
      );
      return;
    }
    case "completed-run": {
      return;
    }
    default: {
      yield* Effect.logWarning("Unknown operation").pipe(
        Effect.annotateLogs({ op: operation.op }),
      );
      return;
    }
  }
});

const cellStateManager = new CellStateManager();

function handleCellOperation(
  operation: CellMessage,
  deps: {
    code: VsCode;
    context: OperationContext;
  },
): Effect.Effect<void, never, never> {
  const { code, context } = deps;
  return Effect.gen(function* () {
    const { cell_id: cellId, status, timestamp = 0 } = operation;
    const state = cellStateManager.handleCellOp(operation);

    switch (status) {
      case "queued": {
        const execution = context.controller.createNotebookCellExecution(
          getNotebookCell(context.editor.notebook, cellId),
        );
        context.executions.set(cellId, execution);
        yield* Effect.logDebug("Cell queued for execution").pipe(
          Effect.annotateLogs({ cellId }),
        );
        return yield* Effect.void;
      }

      case "running": {
        const execution = context.executions.get(cellId);
        assert(execution, `Expected execution for ${cellId}`);
        execution.start(timestamp * 1000);
        yield* Effect.logDebug("Cell execution started").pipe(
          Effect.annotateLogs({ cellId }),
        );
        // MUST modify cell output after `NotebookCellExecution.start`
        yield* updateOrCreateMarimoCellOutput(code, execution, {
          cellId,
          state,
        });
        return;
      }

      case "idle": {
        const execution = context.executions.get(cellId);
        assert(execution, `Expected execution for ${cellId}`);
        // MUST modify cell output before `NotebookCellExecution.end`
        yield* updateOrCreateMarimoCellOutput(code, execution, {
          cellId,
          state,
        });
        execution.end(true, timestamp * 1000);
        context.executions.delete(cellId);
        yield* Effect.logDebug("Cell execution completed").pipe(
          Effect.annotateLogs({ cellId }),
        );
        return;
      }

      default: {
        const execution = context.executions.get(cellId);
        if (execution) {
          yield* updateOrCreateMarimoCellOutput(code, execution, {
            cellId,
            state,
          });
        }
        return;
      }
    }
  });
}

function updateOrCreateMarimoCellOutput(
  code: VsCode,
  execution: vscode.NotebookCellExecution,
  payload: {
    cellId: string;
    state: CellRuntimeState;
  },
): Effect.Effect<void, never, never> {
  return Effect.tryPromise(() =>
    execution.replaceOutput(
      new code.NotebookCellOutput([
        code.NotebookCellOutputItem.json(
          payload,
          "application/vnd.marimo.ui+json",
        ),
      ]),
    ),
  ).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError("Failed to update cell output", cause).pipe(
        Effect.annotateLogs({ cellId: payload.cellId }),
      ),
    ),
  );
}

function getNotebookCell(
  notebook: vscode.NotebookDocument,
  cellId: string,
): vscode.NotebookCell {
  const cell = notebook
    .getCells()
    .find((c) => c.document.uri.toString() === cellId);
  assert(cell, `No cell id ${cellId} in notebook ${notebook.uri.toString()} `);
  return cell;
}

type PackageName = string & Brand.Brand<"PackageName">;

// TODO: Avoid global state
const progressMap: HashMap.HashMap<
  PackageName,
  {
    progress: vscode.Progress<{ message: string }>;
    dispose: () => void;
  }
> = HashMap.empty();

function handleInstallingPackageAlert(
  operation: MessageOperationOf<"installing-package-alert">,
  deps: {
    code: VsCode;
  },
): Effect.Effect<void, never, never> {
  const { code } = deps;

  const newProgress = Effect.fnUntraced(function* (packageName: string) {
    const outer = Promise.withResolvers<void>();
    const inner = Promise.withResolvers<vscode.Progress<{ message: string }>>();
    const progress = yield* code.window.useInfallible(async (api) => {
      api.withProgress(
        {
          title: `Installing ${packageName}`,
          location: code.ProcessLocation.Notification,
          cancellable: true,
        },
        async (progress, token) => {
          inner.resolve(progress);
          token.onCancellationRequested(() => {
            outer.resolve();
            HashMap.remove(progressMap, packageName);
          });
          return outer.promise;
        },
      );
      return inner.promise;
    });
    return { progress, dispose: outer.resolve };
  });

  return code.window.useInfallible((api) =>
    api.showInformationMessage(JSON.stringify(operation)),
  );

  return Effect.gen(function* () {
    for (const entry of Object.entries(operation.packages)) {
      const packageName = entry[0] as PackageName;
      const kind = entry[1];

      switch (kind) {
        case "queued": {
          const existing = HashMap.get(progressMap, packageName);
          if (Option.isSome(existing)) {
            existing.value.dispose();
          }
          const progressState = yield* newProgress(packageName);
          HashMap.set(progressMap, packageName, progressState);
          progressState.progress.report({
            message: `Queued`,
          });
          break;
        }
        case "installing": {
          const existing = HashMap.get(progressMap, packageName);
          if (Option.isSome(existing)) {
            existing.value.progress.report({
              message: `Installing...`,
            });
          }
          break;
        }
        case "installed": {
          const existing = HashMap.get(progressMap, packageName);
          if (Option.isSome(existing)) {
            existing.value.progress.report({
              message: `${packageName} ✓`,
            });
            existing.value.dispose();
            HashMap.remove(progressMap, packageName);
          }
          break;
        }
        case "failed": {
          const existing = HashMap.get(progressMap, packageName);
          if (Option.isSome(existing)) {
            existing.value.progress.report({
              message: `${packageName} ✗`,
            });
            existing.value.dispose();
            HashMap.remove(progressMap, packageName);
          }
          break;
        }
      }
    }
  });
}

function handleMissingPackageAlert(
  operation: MessageOperationOf<"missing-package-alert">,
  deps: {
    context: OperationContext;
    code: VsCode;
    marimo: LanguageClient;
    pypi: PyPiClient;
  },
): Effect.Effect<void, never, never> {
  const { context, code, marimo, pypi } = deps;
  return Effect.gen(function* () {
    const [choice, meta] = yield* Effect.all([
      code.window
        .useInfallible((api) =>
          api.showInformationMessage(
            `Missing packages: ${operation.packages.join(", ")}`,
            "Install All",
            "Customize...",
          ),
        )
        .pipe(Effect.map(Option.fromNullable)),
      Effect.either(
        Effect.forEach(
          operation.packages,
          (name) => pypi.getPackageMetadata(name),
          { concurrency: 5 },
        ),
      ),
    ]);

    if (Option.isNone(choice)) {
      // dismissed
      return;
    }

    if (Either.isLeft(meta)) {
      // failed to get package metadata
      yield* Effect.logError("Packge install failed.", meta.left);
      yield* code.window.useInfallible((api) =>
        api.showErrorMessage(
          "Installation failed. Failed to fetch latest package metadata from PyPI.",
        ),
      );
      return;
    }

    const latestVersions = meta.right.map(({ versions }) => versions[0]);
    const versions = Object.fromEntries(
      operation.packages.map((k, i) => [k, latestVersions[i]]),
    );

    if (choice.value === "Install All") {
      yield* Effect.logInfo("Install packages").pipe(
        Effect.annotateLogs("packages", operation.packages),
      );
      yield* marimo.installPackages({
        notebookUri: context.editor.notebook.uri.toString(),
        inner: {
          manager: "uv",
          versions,
        },
      });
    } else if (choice.value === "Customize...") {
      const response = yield* code.window
        .useInfallible((api) =>
          api.showInputBox({
            prompt: "Add packages",
            value: Object.entries(versions)
              .map(([k, v]) => `${k}==${v}`)
              .join(" "),
            placeHolder: "package1 package2 package3",
          }),
        )
        .pipe(Effect.map(Option.fromNullable));

      if (Option.isNone(response)) {
        return;
      }

      const newPackages = response.value.split(" ");

      yield* Effect.logInfo("Install packages").pipe(
        Effect.annotateLogs("packages", newPackages),
      );

      yield* marimo.installPackages({
        notebookUri: context.editor.notebook.uri.toString(),
        inner: {
          manager: "uv",
          versions: Object.fromEntries(
            newPackages.map((packageString, i) => {
              packageString = packageString.trim();
              const [name, version] = packageString.includes("==")
                ? packageString.split("==")
                : [packageString, null];
              return [name, version ?? latestVersions[i]];
            }),
          ),
        },
      });
    }

    // Cancel - do nothing
  }).pipe(Effect.catchAllCause(Effect.logError));
}
