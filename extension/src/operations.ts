import { Effect, Option } from "effect";
import type * as vscode from "vscode";
import { Config } from "./services/Config.ts";
import type {
  CustomPythonController,
  VenvPythonController,
} from "./services/NotebookControllerFactory.ts";
import type { SandboxController } from "./services/SandboxController.ts";
import { VsCode } from "./services/VsCode.ts";
import type { MessageOperationOf } from "./types.ts";
import { findVenvPath } from "./utils/findVenvPath.ts";
import { installPackages } from "./utils/installPackages.ts";

export const handleMissingPackageAlert = Effect.fnUntraced(function* (
  operation: MessageOperationOf<"missing-package-alert">,
  notebook: vscode.NotebookDocument,
  controller: VenvPythonController | SandboxController | CustomPythonController,
) {
  const code = yield* VsCode;
  const config = yield* Config;

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

  let options: { script: vscode.NotebookDocument } | { venvPath: string };

  if ("executable" in controller) {
    const venvPath = findVenvPath(controller.executable);

    if (Option.isNone(venvPath)) {
      yield* Effect.logWarning("Could not find venv. Skipping install.");
      return;
    }

    options = { venvPath: venvPath.value };
  } else {
    options = { script: notebook };
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

    if ("venvPath" in options) {
      yield* installPackages(operation.packages, options);
    } else {
      yield* installPackages(operation.packages, options);
    }
    return;
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

    if ("venvPath" in options) {
      yield* installPackages(operation.packages, options);
    } else {
      yield* installPackages(operation.packages, options);
    }
  }
});
