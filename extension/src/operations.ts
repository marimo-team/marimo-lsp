import { Effect, Option } from "effect";

import type { MarimoNotebookDocument } from "./schemas.ts";
import type { PythonController } from "./services/NotebookControllerFactory.ts";
import type { SandboxController } from "./services/SandboxController.ts";
import type { NotificationOf } from "./types.ts";

import { TyLanguageServer } from "./services/completions/TyLanguageServer.ts";
import { Config } from "./services/Config.ts";
import { VsCode } from "./services/VsCode.ts";
import { findVenvPath } from "./utils/findVenvPath.ts";
import { installPackages } from "./utils/installPackages.ts";

export const handleMissingPackageAlert = Effect.fnUntraced(function* (
  operation: NotificationOf<"missing-package-alert">,
  notebook: MarimoNotebookDocument,
  controller: PythonController | SandboxController,
) {
  const code = yield* VsCode;
  const config = yield* Config;
  const tyLsp = yield* TyLanguageServer;

  if (operation.packages.length === 0) {
    // Nothing to do
    return;
  }

  if (!config.uv.enabled) {
    // User has uv disabled
    yield* Effect.logDebug("uv integration disabled. Skipping install.").pipe(
      Effect.annotateLogs({
        packages: operation.packages,
      }),
    );

    return;
  }

  let options: { script: MarimoNotebookDocument } | { venvPath: string };

  if ("executable" in controller) {
    // Only venv environments (with pyvenv.cfg) support uv package installation
    // Non-venv environments (pixi, conda, bazel, global) are skipped
    const venvPath = findVenvPath(controller.executable);

    if (Option.isNone(venvPath)) {
      yield* Effect.logDebug(
        "No venv found for environment. Skipping uv install.",
      ).pipe(
        Effect.annotateLogs({
          packages: operation.packages,
          executable: controller.executable,
        }),
      );
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

    // Restart ty to pick up newly installed packages
    yield* tyLsp.restart("packages installed via missing-package-alert");
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
      yield* installPackages(newPackages, options);
    } else {
      yield* installPackages(newPackages, options);
    }

    // Restart ty to pick up newly installed packages
    yield* tyLsp.restart("packages installed via missing-package-alert");
  }
});
