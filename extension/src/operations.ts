import { Effect, Option } from "effect";
import type * as vscode from "vscode";
import type { Config } from "./services/Config.ts";
import type { DatasourcesService } from "./services/datasources/DatasourcesService.ts";
import type { ExecutionRegistry } from "./services/ExecutionRegistry.ts";
import type { NotebookController } from "./services/NotebookControllerFactory.ts";
import type { NotebookRenderer } from "./services/NotebookRenderer.ts";
import type { Uv } from "./services/Uv.ts";
import type { VsCode } from "./services/VsCode.ts";
import type { VariablesService } from "./services/variables/VariablesService.ts";
import type {
  MessageOperation,
  MessageOperationOf,
  NotebookUri,
} from "./types.ts";
import { findVenvPath } from "./utils/findVenvPath.ts";
import { installPackages } from "./utils/installPackages.ts";

export const routeOperation = Effect.fn("routeOperation")(function* (
  operation: MessageOperation,
  deps: {
    runPromise: (e: Effect.Effect<void, never, never>) => Promise<void>;
    editor: vscode.NotebookEditor;
    notebookUri: NotebookUri;
    executions: ExecutionRegistry;
    controller: NotebookController;
    renderer: NotebookRenderer;
    variables: VariablesService;
    datasources: DatasourcesService;
    code: VsCode;
    uv: Uv;
    config: Config;
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
      yield* deps.executions.handleCellOperation(operation, deps);
      break;
    }
    case "interrupted": {
      yield* deps.executions.handleInterrupted(deps.editor);
      break;
    }
    case "completed-run": {
      break;
    }
    case "missing-package-alert": {
      // Handle in a separate fork (we don't want to block resolution)
      deps.runPromise(handleMissingPackageAlert(operation, deps));
      break;
    }
    // Update variable state
    case "variables": {
      yield* deps.variables.updateVariables(deps.notebookUri, operation);
      break;
    }
    case "variable-values": {
      yield* deps.variables.updateVariableValues(deps.notebookUri, operation);
      break;
    }
    // Update datasource state
    case "data-source-connections": {
      yield* deps.datasources.updateConnections(deps.notebookUri, operation);
      break;
    }
    case "datasets": {
      yield* deps.datasources.updateDatasets(deps.notebookUri, operation);
      break;
    }
    case "sql-table-preview": {
      yield* deps.datasources.updateTablePreview(deps.notebookUri, operation);
      break;
    }
    case "sql-table-list-preview": {
      yield* deps.datasources.updateTableListPreview(
        deps.notebookUri,
        operation,
      );
      break;
    }
    case "data-column-preview": {
      yield* deps.datasources.updateColumnPreview(deps.notebookUri, operation);
      break;
    }
    // Forward to renderer (front end) (non-blocking)
    case "remove-ui-elements":
    case "function-call-result":
    case "send-ui-element-message": {
      deps.runPromise(deps.renderer.postMessage(operation, deps.editor));
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

function handleMissingPackageAlert(
  operation: MessageOperationOf<"missing-package-alert">,
  deps: {
    controller: NotebookController;
    code: VsCode;
    uv: Uv;
    config: Config;
  },
): Effect.Effect<void, never, never> {
  const { code, config, controller } = deps;

  return Effect.gen(function* () {
    if (operation.packages.length === 0) {
      // Nothing to do
      return;
    }

    if (!config.uv.enabled) {
      // Use has uv disabled
      yield* Effect.logDebug("uv integration disabled. Skipping install.").pipe(
        Effect.annotateLogs({
          packages: operation.packages,
        }),
      );

      return;
    }

    const venv = findVenvPath(controller.env.path);

    if (Option.isNone(venv)) {
      yield* Effect.logWarning("Could not find venv. Skipping install.");
      return;
    }

    const choice = yield* code.window.showInformationMessage(
      operation.packages.length === 1
        ? `Missing package: ${operation.packages[0]}. Install with uv?`
        : `Missing packages: ${operation.packages.join(", ")}. Install with uv?`,
      {
        items: ["Install All", "Customize..."],
      },
    );

    if (Option.isNone(choice)) {
      // dismissed
      return;
    }

    if (choice.value === "Install All") {
      yield* Effect.logInfo("Install packages").pipe(
        Effect.annotateLogs("packages", operation.packages),
      );
      yield* installPackages(venv.value, operation.packages, deps);
    }

    if (choice.value === "Customize...") {
      const response = yield* code.window.showInputBox({
        prompt: "Add packages",
        value: operation.packages.join(" "),
        placeHolder: "package1 package2 package3",
      });

      if (Option.isNone(response)) {
        return;
      }

      const newPackages = response.value.split(" ");
      yield* Effect.logInfo("Install packages").pipe(
        Effect.annotateLogs("packages", newPackages),
      );

      yield* installPackages(venv.value, newPackages, deps);
    }
  }).pipe(Effect.catchAllCause(Effect.logError));
}
