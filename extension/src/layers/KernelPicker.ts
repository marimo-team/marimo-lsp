/**
 * Custom kernel picker with status bar button and QuickPick UI.
 * Provides better UX for custom Python paths with inline delete buttons.
 */
import { Effect, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";
import { ControllerRegistry } from "../services/ControllerRegistry.ts";
import { CustomPythonPathService } from "../services/CustomPythonPathService.ts";
import { VsCode } from "../services/VsCode.ts";
import { isMarimoNotebookDocument } from "../utils/notebook.ts";

interface KernelQuickPickItem extends vscode.QuickPickItem {
  kind2:
    | "custom"
    | "sandbox"
    | "add"
    | "separator"
    | "native" /** Use native kernel picker */;
  /** For custom paths, the path ID for deletion */
  customPathId?: string;
}

export const KernelPickerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const customPythonPathService = yield* CustomPythonPathService;
    const controllerRegistry = yield* ControllerRegistry;

    // Create status bar item that opens our custom kernel picker with delete buttons
    const statusBarItem = yield* code.window.createStatusBarItem(
      "marimo.kernelPicker",
      code.StatusBarAlignment.Right,
      100,
    );
    statusBarItem.text = "$(server-process) Select Kernel";
    statusBarItem.tooltip = "Click to select marimo kernel";
    statusBarItem.command = "marimo.showKernelPicker";

    // Update status bar visibility and text based on active editor
    yield* Effect.forkScoped(
      code.window.activeNotebookEditorChanges().pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* (editor) {
            if (
              Option.isSome(editor) &&
              isMarimoNotebookDocument(editor.value.notebook)
            ) {
              statusBarItem.show();

              // Get active controller for this notebook
              const controller = yield* controllerRegistry.getActiveController(
                editor.value.notebook,
              );
              if (Option.isSome(controller)) {
                const ctrl = controller.value;
                let label = "Unknown";
                let description: string | undefined;

                switch (ctrl._tag) {
                  case "VenvPythonController":
                    label = "venv";
                    description = ctrl.executable;
                    break;
                  case "SandboxController":
                    label = "marimo sandbox";
                    break;
                  case "CustomPythonController": {
                    // Find the nickname
                    const paths = yield* customPythonPathService.getAll;
                    const found = paths.find(
                      (p) => p.pythonPath === ctrl.executable,
                    );
                    label = found?.nickname ?? "Custom";
                    description = ctrl.executable;
                    break;
                  }
                }

                statusBarItem.text = `$(server-process) ${label}`;
                statusBarItem.tooltip = description
                  ? `Kernel: ${label}\n${description}\nClick to change`
                  : `Kernel: ${label}\nClick to change`;
              } else {
                statusBarItem.text = "$(server-process) Select Kernel";
              }
            } else {
              statusBarItem.hide();
            }
          }),
        ),
        Stream.runDrain,
      ),
    );

    // Shared logic for showing the custom kernel picker
    const showCustomKernelPicker = Effect.gen(function* () {
      const editor = yield* code.window.getActiveNotebookEditor();
      if (
        Option.isNone(editor) ||
        !isMarimoNotebookDocument(editor.value.notebook)
      ) {
        yield* code.window.showInformationMessage(
          "Please open a marimo notebook first.",
        );
        return;
      }

      // Build the list of kernels
      const customPaths = yield* customPythonPathService.getAll;

      const deleteButton: vscode.QuickInputButton = {
        iconPath: new code.ThemeIcon("close"),
        tooltip: "Remove this custom Python path",
      };

      const items: KernelQuickPickItem[] = [];

      // Add custom Python paths with delete buttons
      for (const customPath of customPaths) {
        items.push({
          label: `$(terminal) ${customPath.nickname}`,
          description: customPath.pythonPath,
          kind2: "custom",
          customPathId: customPath.id,
          buttons: [deleteButton],
        });
      }

      // Add separator if we have custom paths
      if (customPaths.length > 0) {
        items.push({
          label: "Other Kernels",
          kind: -1 as vscode.QuickPickItemKind, // Separator
          kind2: "separator",
        });
      }

      // Add sandbox controller
      items.push({
        label: "$(package) marimo sandbox",
        description: "Isolated environment with inline dependencies",
        kind2: "sandbox",
      });

      // Add option to use native picker for venv selection
      items.push({
        label: "$(folder) Select from Python environments...",
        description: "Use VS Code's native kernel picker",
        kind2: "native",
      });

      // Add separator before "Add"
      items.push({
        label: "Management",
        kind: -1 as vscode.QuickPickItemKind,
        kind2: "separator",
      });

      // Add "Add Custom Python Path..." option
      items.push({
        label: "$(add) Add Custom Python Path...",
        description: "Add a Bazel or other custom Python executable",
        kind2: "add",
      });

      // Create and show quick pick
      const result = yield* showQuickPickWithButtons(
        code,
        items,
        "Select a kernel for this notebook",
        deleteButton,
      );

      if (!result) {
        return; // Cancelled
      }

      // Handle button click (delete)
      if (result.type === "button") {
        const item = result.item;
        if (item.customPathId) {
          const paths = yield* customPythonPathService.getAll;
          const pathToDelete = paths.find((p) => p.id === item.customPathId);
          const name = pathToDelete?.nickname ?? "this custom path";

          const confirm = yield* code.window.showWarningMessage(
            `Remove "${name}"?`,
            { modal: true, items: ["Remove"] },
          );

          if (Option.isSome(confirm)) {
            yield* customPythonPathService.remove(item.customPathId);
            yield* code.window.showInformationMessage(`Removed: ${name}`);
          }
        }
        return;
      }

      // Handle selection
      const selected = result.item;

      if (selected.kind2 === "add") {
        yield* customPythonPathService.promptAdd;
        return;
      }

      if (selected.kind2 === "native") {
        // Open VS Code's native kernel picker
        yield* code.commands.executeCommand("notebook.selectKernel");
        return;
      }

      // Select the kernel
      if (selected.kind2 === "sandbox") {
        yield* code.commands.executeCommand("notebook.selectKernel", {
          id: "marimo-sandbox",
          extension: "marimo-team.vscode-marimo",
        });
      } else if (selected.kind2 === "custom" && selected.customPathId) {
        yield* code.commands.executeCommand("notebook.selectKernel", {
          id: `marimo-custom-${selected.customPathId}`,
          extension: "marimo-team.vscode-marimo",
        });
      }
    }).pipe(
      Effect.catchAll((error) => Effect.logError("Kernel picker error", error)),
    );

    // Register the command to show the picker (for command palette)
    yield* code.commands.registerCommand(
      "marimo.showKernelPicker",
      showCustomKernelPicker,
    );

    yield* Effect.logInfo("Kernel picker initialized");
  }),
);

/**
 * Show a QuickPick with button support.
 * Returns either { type: "select", item } or { type: "button", item, button }
 */
function showQuickPickWithButtons<T extends vscode.QuickPickItem>(
  code: VsCode,
  items: T[],
  placeholder: string,
  deleteButton: vscode.QuickInputButton,
): Effect.Effect<
  { type: "select"; item: T } | { type: "button"; item: T } | null
> {
  return Effect.async<
    { type: "select"; item: T } | { type: "button"; item: T } | null
  >((resume) => {
    const quickPick = code.window.createQuickPickRaw<T>();
    quickPick.items = items;
    quickPick.placeholder = placeholder;
    quickPick.title = "Select Kernel";

    let resolved = false;

    quickPick.onDidTriggerItemButton((e) => {
      if (!resolved && e.button === deleteButton) {
        resolved = true;
        quickPick.hide();
        resume(Effect.succeed({ type: "button", item: e.item }));
      }
    });

    quickPick.onDidAccept(() => {
      if (!resolved) {
        const selected = quickPick.selectedItems[0];
        resolved = true;
        quickPick.hide();
        resume(
          Effect.succeed(selected ? { type: "select", item: selected } : null),
        );
      }
    });

    quickPick.onDidHide(() => {
      if (!resolved) {
        resolved = true;
        resume(Effect.succeed(null));
      }
      quickPick.dispose();
    });

    quickPick.show();
  });
}
