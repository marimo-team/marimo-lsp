import { Context, Effect, Layer, Scope } from "effect";
import type * as vscode from "vscode";

import type { MarimoView } from "../constants.ts";
import * as VsCode from "../platform/VsCode.ts";

/**
 * Manages VS Code tree view items with automatic disposal.
 *
 * @example Basic usage
 * ```ts
 * const program = Effect.gen(function* () {
 *   const treeView = yield* TreeView.Service;
 *
 *   // Create a tree data provider
 *   const provider = yield* treeView.createTreeDataProvider({
 *     viewId: "marimo-explorer-sessions",
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
export interface Provider<T> {
  readonly refresh: (element?: T) => Effect.Effect<void>;
  readonly reveal: (
    element: T,
    options?: { select?: boolean; focus?: boolean; expand?: boolean },
  ) => Effect.Effect<void>;
}

export interface Interface {
  readonly createTreeDataProvider: <T>(options: {
    viewId: MarimoView;
    getChildren: (element?: T) => Effect.Effect<T[]>;
    getTreeItem: (element: T) => Effect.Effect<TreeItem>;
    showCollapseAll?: boolean;
  }) => Effect.Effect<Provider<T>, never, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/TreeView",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const code = yield* VsCode.Service;

    const createTreeDataProvider = Effect.fn("TreeView.createTreeDataProvider")(
      function* <T>(options: {
        viewId: MarimoView;
        getChildren: (element?: T) => Effect.Effect<T[]>;
        getTreeItem: (element: T) => Effect.Effect<TreeItem>;
        showCollapseAll?: boolean;
      }) {
        const context = yield* Effect.context();
        const runPromise = Effect.runPromiseWith(context);
        const runSync = Effect.runSyncWith(context);
        const eventEmitter = yield* Effect.acquireRelease(
          Effect.sync(() => new code.EventEmitter<T | undefined | null>()),
          (emitter) => Effect.sync(() => emitter.dispose()),
        );

        const treeView = yield* code.window.createTreeView(options.viewId, {
          treeDataProvider: {
            onDidChangeTreeData: eventEmitter.event,
            getTreeItem: (element: T): vscode.TreeItem =>
              toVSCodeTreeItem(code, runSync(options.getTreeItem(element))),
            getChildren: (element?: T): vscode.ProviderResult<T[]> =>
              runPromise(options.getChildren(element)),
          },
          showCollapseAll: options.showCollapseAll ?? true,
        });

        const refresh = Effect.fn("TreeView.Provider.refresh")(function* (
          element?: T,
        ) {
          yield* Effect.sync(() => eventEmitter.fire(element ?? null));
        });

        const reveal = Effect.fn("TreeView.Provider.reveal")(function* (
          element: T,
          opts?: { select?: boolean; focus?: boolean; expand?: boolean },
        ) {
          yield* Effect.promise(() => treeView.reveal(element, opts));
        });

        return { refresh, reveal };
      },
    );

    return Service.of({ createTreeDataProvider });
  }),
);

/**
 * Configuration for a tree item.
 */
export interface TreeItem {
  id?: string;
  label: string;
  description?: string;
  tooltip?: string;
  iconPath?: string | { light: string; dark: string };
  themeIcon?: string;
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
 * The service value's type, extracted with `Context.Service.Shape`.
 */
type VsCodeService = VsCode.Interface;

/**
 * Converts our TreeItem to VS Code's TreeItem.
 *
 * TODO: should this be an Effect?
 */
function toVSCodeTreeItem(
  vscode: VsCodeService,
  item: TreeItem,
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(
    item.label,
    item.collapsibleState === "Collapsed"
      ? vscode.TreeItemCollapsibleState.Collapsed
      : item.collapsibleState === "Expanded"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
  );

  if (item.id) {
    treeItem.id = item.id;
  }

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

  if (item.themeIcon) {
    treeItem.iconPath = new vscode.ThemeIcon(item.themeIcon);
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
