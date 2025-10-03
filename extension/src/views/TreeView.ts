import { Effect } from "effect";
import type * as vscode from "vscode";
import type { MarimoViewKey } from "../constants.ts";
import { VsCode } from "../services/VsCode.ts";

/**
 * Manages VS Code tree view items with automatic disposal.
 *
 * @example Basic usage
 * ```ts
 * const program = Effect.gen(function* () {
 *   const treeView = yield* TreeView;
 *
 *   // Create a tree data provider
 *   const provider = yield* treeView.createTreeDataProvider({
 *     viewId: "marimo-explorer-recents",
 *     getChildren: (element) => {
 *       // Return array of tree items
 *       return Effect.succeed([]);
 *     },
 *   });
 *
 *   // Refresh the tree view
 *   yield* provider.refresh();
 * });
 * ```
 */
export class TreeView extends Effect.Service<TreeView>()("TreeView", {
  dependencies: [VsCode.Default],
  scoped: Effect.gen(function* () {
    yield* VsCode;

    return {
      /**
       * Creates a tree data provider with automatic cleanup on scope disposal.
       *
       * @param options - Configuration for the tree view
       */
      createTreeDataProvider<T>(options: {
        viewId: MarimoViewKey;
        getChildren: (element?: T) => Effect.Effect<T[], never, never>;
        getTreeItem: (element: T) => Effect.Effect<TreeItem, never, never>;
        getParent?: (element: T) => Effect.Effect<T | undefined, never, never>;
      }) {
        return Effect.gen(function* () {
          const code = yield* VsCode;

          // Create event emitter for refresh events
          const eventEmitter = new code.EventEmitter<T | undefined | null>();

          // Create the tree data provider implementation
          const provider: vscode.TreeDataProvider<T> = {
            onDidChangeTreeData: eventEmitter.event,

            getTreeItem: (element: T): vscode.TreeItem => {
              // This is synchronous in VS Code API, but we need to run effect
              // For now, we'll use a simple synchronous version
              // In practice, you'd cache or compute items ahead of time
              const item = Effect.runSync(options.getTreeItem(element));
              return toVSCodeTreeItem(code, item);
            },

            getChildren: (element?: T): vscode.ProviderResult<T[]> => {
              return Effect.runPromise(options.getChildren(element));
            },

            getParent: options.getParent
              ? (element: T): vscode.ProviderResult<T> => {
                  const getParentFn = options.getParent;
                  if (!getParentFn) {
                    return null;
                  }
                  return Effect.runPromise(
                    getParentFn(element).pipe(
                      Effect.map((parent) => parent ?? null),
                    ),
                  );
                }
              : undefined,
          };

          // Register the tree data provider
          const treeView = yield* code.window.createTreeView(options.viewId, {
            treeDataProvider: provider,
            showCollapseAll: true,
          });

          return {
            /**
             * Refreshes the entire tree view.
             */
            refresh(element?: T) {
              return Effect.sync(() => eventEmitter.fire(element ?? null));
            },

            /**
             * Reveals an element in the tree view.
             */
            reveal(
              element: T,
              options?: { select?: boolean; focus?: boolean; expand?: boolean },
            ) {
              return Effect.promise(() => treeView.reveal(element, options));
            },

            /**
             * Direct access to the underlying VS Code TreeView.
             * Use with caution - prefer the provided methods.
             */
            get raw() {
              return treeView;
            },

            /**
             * Get the event emitter for manual control.
             */
            get eventEmitter() {
              return eventEmitter;
            },
          };
        });
      },
    };
  }).pipe(Effect.annotateLogs("service", "TreeView")),
}) {}

/**
 * Configuration for a tree item.
 */
export interface TreeItem {
  label: string;
  description?: string;
  tooltip?: string;
  iconPath?: string | { light: string; dark: string };
  contextValue?: string;
  command?:
    | string
    | {
        command: string;
        title: string;
        arguments?: unknown[];
      };
  collapsibleState?: "None" | "Collapsed" | "Expanded";
  resourceUri?: string;
}

/**
 * Converts our TreeItem to VS Code's TreeItem.
 *
 * TODO: should this be an Effect?
 */
function toVSCodeTreeItem(vscode: VsCode, item: TreeItem): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(
    item.label,
    item.collapsibleState === "Collapsed"
      ? vscode.TreeItemCollapsibleState.Collapsed
      : item.collapsibleState === "Expanded"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
  );

  if (item.description) {
    treeItem.description = item.description;
  }

  if (item.tooltip) {
    treeItem.tooltip = item.tooltip;
  }

  if (item.iconPath) {
    if (typeof item.iconPath === "string") {
      treeItem.iconPath = vscode.Uri.file(item.iconPath);
    } else {
      treeItem.iconPath = {
        light: vscode.Uri.file(item.iconPath.light),
        dark: vscode.Uri.file(item.iconPath.dark),
      };
    }
  }

  if (item.contextValue) {
    treeItem.contextValue = item.contextValue;
  }

  if (item.command) {
    if (typeof item.command === "string") {
      treeItem.command = {
        command: item.command,
        title: item.label,
      };
    } else {
      treeItem.command = item.command;
    }
  }

  if (item.resourceUri) {
    treeItem.resourceUri = vscode.Uri.parse(item.resourceUri);
  }

  return treeItem;
}
