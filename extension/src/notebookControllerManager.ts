import { execFile } from "node:child_process";
import * as semver from "@std/semver";
import type * as py from "@vscode/python-extension";
import * as vscode from "vscode";
import type * as lsp from "vscode-languageclient";

import * as cmds from "./commands.ts";
import { Logger } from "./logging.ts";
import { getPythonApi } from "./python.ts";
import { notebookType } from "./types.ts";

export function createNotebookControllerManager(
  client: lsp.BaseLanguageClient,
  options: { signal: AbortSignal },
) {
  // Single map for both controller and environment
  const controllers = new Map<string, vscode.NotebookController>();
  const selectedControllers = new WeakMap<
    vscode.NotebookDocument,
    vscode.NotebookController
  >();

  function isControllerInUse(controllerId: string): boolean {
    return vscode.workspace.notebookDocuments.some(
      (doc) => selectedControllers.get(doc)?.id === controllerId,
    );
  }

  // Create or update controller for Python environment
  function createOrUpdateController(env: py.Environment) {
    const controllerId = `marimo-${env.id}`;
    const controllerLabel = formatControllerLabel(env);

    {
      // Just update the controller if it exists
      const existing = controllers.get(controllerId);
      if (existing) {
        existing.label = controllerLabel;
        Logger.trace(
          "Controller.Update",
          "Updated controller:",
          controllerId,
          controllerLabel,
        );
        return;
      }
    }

    const controller = vscode.notebooks.createNotebookController(
      controllerId,
      notebookType,
      controllerLabel,
      async (cells, notebook, controller) => {
        Logger.info("Controller.Execute", "Running cells", {
          controllerId: controller.id,
          cellCount: cells.length,
          notebook: notebook.uri.toString(),
        });

        const version = await tryGetMarimoVersion(env, options);

        if (!version) {
          const envName = resolvePythonEnvironmentName(env);
          const envLabel = envName
            ? `"${envName}"`
            : "the selected environment";
          await vscode.window.showErrorMessage(
            `Could not find marimo in ${envLabel}. Please ensure marimo is installed.`,
            { modal: true },
          );

          return;
        }

        if (
          !semver.greaterOrEqual(version, { major: 0, minor: 14, patch: 0 })
        ) {
          const envName = resolvePythonEnvironmentName(env);
          const envLabel = envName
            ? `"${envName}"`
            : "the selected environment";
          await vscode.window.showWarningMessage(
            `marimo version in ${envLabel} is outdated (v${semver.format(version)}). Please update to v0.14.0 or later.`,
            { modal: true },
          );

          return;
        }

        await cmds.executeCommand(client, {
          command: "marimo.run",
          params: {
            notebookUri: notebook.uri.toString(),
            cellIds: cells.map((cell) => cell.document.uri.toString()),
            codes: cells.map((cell) => cell.document.getText()),
          },
        });
      },
    );

    controller.supportedLanguages = ["python"];
    controller.description = env.path;

    // Track selection changes
    controller.onDidChangeSelectedNotebooks((e) => {
      if (e.selected) {
        selectedControllers.set(e.notebook, controller);
        Logger.trace(
          "Controller.Selection",
          `Controller ${controllerId} selected for notebook ${e.notebook.uri.toString()}`,
        );
      }
      // NB: We don't delete from selectedControllers when deselected
      // because another controller will overwrite it when selected
    });

    controllers.set(controllerId, controller);
    Logger.trace("Controller.Create", "Created controller:", controllerId);
  }

  function refreshControllers(api: py.PythonExtension) {
    const environments = api.environments.known;
    const currentEnvIds = new Set(environments.map((e) => `marimo-${e.id}`));

    Logger.trace(
      "Controller.Refresh",
      `Refreshing controllers. Found ${environments.length} environments`,
    );

    // Remove controllers for deleted environments (if not in use)
    for (const [id, controller] of controllers) {
      if (!currentEnvIds.has(id)) {
        if (isControllerInUse(id)) {
          Logger.trace(
            "Controller.Skip",
            `Skipping disposal of ${id} - currently in use`,
          );
        } else {
          Logger.trace("Controller.Dispose", `Disposing controller ${id}`);
          controller.dispose();
          controllers.delete(id);
        }
      }
    }

    for (const env of environments) {
      createOrUpdateController(env);
    }
  }

  function initialize(api: py.PythonExtension) {
    refreshControllers(api);

    const envChangeListener = api.environments.onDidChangeEnvironments(() => {
      Logger.trace("Controller.EnvChange", "Python environments changed");
      refreshControllers(api);
    });

    options.signal.addEventListener("abort", () => {
      Logger.info("Controller.Lifecycle", "Disposing controller manager");
      envChangeListener.dispose();
      for (const controller of controllers.values()) {
        controller.dispose();
      }
      controllers.clear();
    });

    Logger.info(
      "Controller.Lifecycle",
      `Controller manager initialized with ${controllers.size} controllers`,
    );
  }

  // TODO: await this somewhere?
  getPythonApi()
    .then((api) => initialize(api))
    .catch((error) => {
      Logger.error(
        "Controller.Error",
        "Failed to initialize controller manager",
        error,
      );
    });

  return {
    /**
     * Get the currently selected controller for a notebook document
     */
    getSelectedController(
      notebook: vscode.NotebookDocument,
    ): vscode.NotebookController | undefined {
      return selectedControllers.get(notebook);
    },
  };
}

/**
 * Format a {@link py.Environment} similar to vscode-jupyter
 *
 * E.g. "EnvName (Python 3.10.2)" or just "Python 3.10.2"
 */
function formatControllerLabel(env: py.Environment): string {
  const versionParts: Array<number> = [];
  if (env.version) {
    if (typeof env.version.major === "number") {
      versionParts.push(env.version.major);
      if (typeof env.version.minor === "number") {
        versionParts.push(env.version.minor);
        if (typeof env.version.micro === "number") {
          versionParts.push(env.version.micro);
        }
      }
    }
  }
  const formatted =
    versionParts.length > 0 ? `Python ${versionParts.join(".")}` : "Python";

  // Format similar to vscode-jupyter: "EnvName (Python 3.10.2)" or just "Python 3.10.2"
  const envName = resolvePythonEnvironmentName(env);
  if (envName) {
    return `${envName} (${formatted})`;
  }
  return formatted;
}

async function tryGetMarimoVersion(
  env: py.Environment,
  options: {
    signal?: AbortSignal;
  },
): Promise<semver.SemVer | undefined> {
  return new Promise((resolve) => {
    execFile(
      env.path,
      ["-c", "import marimo; print(marimo.__version__)"],
      { signal: options.signal },
      (error, stdout) => {
        resolve(error ? undefined : semver.tryParse(stdout.trim()));
      },
    );
  });
}

/**
 * A human readable name for a {@link py.Environment}
 */
export function resolvePythonEnvironmentName(
  env: py.Environment,
): string | undefined {
  if (env.environment?.name) {
    return env.environment.name;
  }
  if (env.environment?.folderUri) {
    return vscode.Uri.parse(env.environment.folderUri.toString())
      .path.split("/")
      .pop();
  }
  return undefined;
}
