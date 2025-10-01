import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { Effect, Option } from "effect";
import type * as vscode from "vscode";
import { assert } from "./assert.ts";
import type { NotebookController } from "./services/NotebookControllers.ts";
import type { NotebookRenderer } from "./services/NotebookRenderer.ts";
import type { Uv } from "./services/Uv.ts";
import type { VsCode } from "./services/VsCode.ts";
import { type CellRuntimeState, CellStateManager } from "./shared/cells.ts";
import type {
  CellMessage,
  MessageOperation,
  MessageOperationOf,
} from "./types.ts";

export interface OperationContext {
  editor: vscode.NotebookEditor;
  controller: NotebookController;
  executions: Map<string, vscode.NotebookCellExecution>;
}

export const routeOperation = Effect.fn("routeOperation")(function* (
  operation: MessageOperation,
  deps: {
    runPromise: (e: Effect.Effect<void, never, never>) => Promise<void>;
    context: OperationContext;
    renderer: NotebookRenderer;
    code: VsCode;
    uv: Uv;
  },
) {
  yield* Effect.logDebug("Handling operation").pipe(
    Effect.annotateLogs("op", "operation"),
  );
  yield* Effect.logTrace("Handling operation").pipe(
    Effect.annotateLogs("operation", operation),
  );

  switch (operation.op) {
    case "cell-op": {
      yield* handleCellOperation(operation, deps);
      break;
    }
    case "missing-package-alert": {
      yield* handleMissingPackageAlert(operation, deps);
      break;
    }
    // Forward to renderer (front end)
    case "remove-ui-elements":
    case "function-call-result":
    case "send-ui-element-message": {
      yield* deps.renderer.postMessage(operation, deps.context.editor);
      break;
    }
    case "interrupted": {
      // Clear all pending executions when run is interrupted
      for (const execution of deps.context.executions.values()) {
        execution.end(false, Date.now());
      }
      deps.context.executions.clear();
      break;
    }
    case "completed-run": {
      break;
    }
    default: {
      yield* Effect.logWarning("Unknown operation").pipe(
        Effect.annotateLogs({ op: operation.op }),
      );
      return;
    }
  }
  yield* Effect.logDebug("Handled operation").pipe(
    Effect.annotateLogs({ op: operation.op }),
  );
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
        const execution = context.controller.inner.createNotebookCellExecution(
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

function handleMissingPackageAlert(
  operation: MessageOperationOf<"missing-package-alert">,
  deps: {
    runPromise: (e: Effect.Effect<void, never, never>) => Promise<void>;
    context: OperationContext;
    code: VsCode;
    uv: Uv;
  },
): Effect.Effect<void, never, never> {
  const { context, code, uv } = deps;

  const installPackages = (venvPath: string, packages: ReadonlyArray<string>) =>
    code.window.useInfallible((api) =>
      api.withProgress(
        {
          location: code.ProcessLocation.Notification,
          title: `Installing ${packages.length > 1 ? "packages" : "package"}`,
          cancellable: true,
        },
        (progress) =>
          deps.runPromise(
            Effect.gen(function* () {
              progress.report({
                message: `Installing ${packages.join(", ")}...`,
              });
              yield* uv.pipInstall(packages, { target: venvPath });
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
          ),
      ),
    );
  return Effect.gen(function* () {
    const venv = findVenvPath(context.controller.env.path);

    if (Option.isNone(venv)) {
      // no venv so can't do anything
      return;
    }

    const choice = yield* code.window
      .useInfallible((api) =>
        api.showInformationMessage(
          `Missing packages: ${operation.packages.join(", ")}. Install with uv?`,
          "Install All",
          "Customize...",
        ),
      )
      .pipe(Effect.map(Option.fromNullable));

    if (Option.isNone(choice)) {
      // dismissed
      return;
    }

    if (choice.value === "Install All") {
      yield* Effect.logInfo("Install packages").pipe(
        Effect.annotateLogs("packages", operation.packages),
      );
      yield* installPackages(venv.value, operation.packages);
    } else if (choice.value === "Customize...") {
      const response = yield* code.window
        .useInfallible((api) =>
          api.showInputBox({
            prompt: "Add packages",
            value: operation.packages.join(" "),
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
      yield* installPackages(venv.value, newPackages);
    }

    // Cancel - do nothing
  }).pipe(Effect.catchAllCause(Effect.logError));
}

/**
 * Resolves a path to a virtual environment directory.
 *
 * VS Code typically represents Python environments by their executable path
 * (e.g., `.venv/bin/python` or `.venv/Scripts/python.exe`), but we need the
 * actual virtual environment directory (e.g., `.venv`) for package installation.
 *
 * If the target is a Python executable, looks two directories up for `pyvenv.cfg`
 * to locate the venv root. Otherwise, checks if the target itself is a venv by
 * looking for `pyvenv.cfg` in that directory.
 *
 * @param target - Path to check (either a Python executable or directory)
 * @returns Some(venv_path) if a valid venv is found, None otherwise
 */
function findVenvPath(target: string): Option.Option<string> {
  const basename = NodePath.basename(target);

  const isPython =
    basename === "python" ||
    basename.startsWith("python3") ||
    basename === "python.exe" ||
    basename.startsWith("python3.") ||
    basename === "python3.exe";

  if (isPython) {
    // Look two directories up (e.g., .venv/bin/python -> .venv)
    const candidate = NodePath.resolve(target, "..", "..");

    // Check if the target itself has pyvenv.cfg
    return NodeFs.existsSync(NodePath.join(candidate, "pyvenv.cfg"))
      ? Option.some(candidate)
      : Option.none();
  }

  // Check if the target itself has pyvenv.cfg
  return NodeFs.existsSync(NodePath.join(target, "pyvenv.cfg"))
    ? Option.some(target)
    : Option.none();
}
