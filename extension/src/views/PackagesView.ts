import { Effect, Layer, Option, Ref, Stream } from "effect";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import type { DependencyTreeNode } from "../services/packages/PackagesService.ts";
import { PackagesService } from "../services/packages/PackagesService.ts";
import { VsCode } from "../services/VsCode.ts";
import type { NotebookUri } from "../types.ts";
import { Log } from "../utils/log.ts";
import { TreeView } from "./TreeView.ts";

interface PackageTreeItem {
  type: "package";
  notebookUri: NotebookUri;
  name: string;
  version: string | null;
  tags: readonly Record<string, string>[];
  dependencies: readonly DependencyTreeNode[];
}

/**
 * Manages the packages tree view for the active notebook.
 *
 * Displays a hierarchical view of package dependencies as a tree.
 *
 * Subscribes to package dependency tree changes and updates the view in real-time.
 */
export const PackagesViewLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const treeView = yield* TreeView;
    const packagesService = yield* PackagesService;
    const editorRegistry = yield* NotebookEditorRegistry;
    const code = yield* VsCode;

    // Track the current package tree items for the active notebook
    const packageItems = yield* Ref.make<readonly PackageTreeItem[]>([]);

    // Create the tree data provider
    const provider = yield* treeView.createTreeDataProvider({
      viewId: "marimo-explorer-packages",
      getChildren: (element?: PackageTreeItem) =>
        Effect.gen(function* () {
          if (!element) {
            // Root level: return top-level packages
            const items = yield* Ref.get(packageItems);
            return [...items];
          }

          // Return dependencies of this package
          const notebookUri = element.notebookUri;
          return [
            ...element.dependencies.map((dep) => ({
              type: "package" as const,
              notebookUri,
              name: dep.name,
              version: dep.version,
              tags: dep.tags,
              dependencies: dep.dependencies,
            })),
          ];
        }),
      getTreeItem: (element: PackageTreeItem) =>
        Effect.succeed({
          label: element.name,
          description: element.version ?? undefined,
          tooltip: `${element.name}${element.version ? `@${element.version}` : ""}${
            element.tags.length > 0
              ? `\n${element.tags
                  .map((t) =>
                    Object.entries(t)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(", "),
                  )
                  .join("\n")}`
              : ""
          }`,
          iconPath: undefined,
          contextValue: "marimoPackage",
          collapsibleState:
            element.dependencies.length > 0
              ? ("Collapsed" as const)
              : ("None" as const),
        }),
    });

    // Helper to rebuild the package tree from current state
    const refreshPackages = Effect.fnUntraced(function* () {
      const activeNotebookUri = yield* editorRegistry.getActiveNotebookUri();

      yield* Log.info("Refreshing packages", {
        activeNotebookUri: Option.getOrElse(activeNotebookUri, () => null),
      });
      if (Option.isNone(activeNotebookUri)) {
        yield* Ref.set(packageItems, []);
        yield* provider.refresh();
        return;
      }

      const notebookUri = activeNotebookUri.value;

      // Check if we already have the dependency tree cached
      const cachedTreeState =
        yield* packagesService.getDependencyTree(notebookUri);

      if (Option.isNone(cachedTreeState)) {
        // No cached tree, fetch it
        yield* packagesService.fetchDependencyTree(notebookUri);
        // Will be updated via the stream subscription
        return;
      }

      const { tree, loading, error } = cachedTreeState.value;

      if (loading || error || !tree) {
        yield* Ref.set(packageItems, []);
        yield* provider.refresh();
        return;
      }

      // Convert tree to flat list of root packages
      const items: PackageTreeItem[] = [
        {
          type: "package",
          notebookUri,
          name: tree.name,
          version: tree.version,
          tags: tree.tags,
          dependencies: tree.dependencies,
        },
      ];

      yield* Log.info("Refreshed packages", {
        rootPackage: tree.name,
        version: tree.version,
        totalDependencies: tree.dependencies.length,
      });
      yield* Ref.set(packageItems, items);
      yield* provider.refresh();
    });

    // Subscribe to active notebook changes
    yield* Effect.forkScoped(
      editorRegistry.streamActiveNotebookChanges().pipe(
        Stream.mapEffect(() => {
          return refreshPackages();
        }),
        Stream.runDrain,
      ),
    );

    // Subscribe to dependency tree changes
    yield* Effect.forkScoped(
      packagesService.streamDependencyTreeChanges().pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* (_treeMap) {
            yield* refreshPackages();
          }),
        ),
        Stream.runDrain,
      ),
    );

    // Initialize with current state
    yield* Effect.forkScoped(refreshPackages());

    // Register command to refresh packages
    yield* code.commands.registerCommand(
      "marimo.refreshPackages",
      Effect.gen(function* () {
        const activeNotebookUri = yield* editorRegistry.getActiveNotebookUri();
        if (Option.isNone(activeNotebookUri)) {
          yield* Log.warn("No active notebook to refresh packages");
          return;
        }

        const notebookUri = activeNotebookUri.value;
        yield* Log.info("Refreshing packages", { notebookUri });

        // Clear cache and force re-fetch
        yield* packagesService.setDependencyTreeLoading(notebookUri, true);
        yield* packagesService.fetchDependencyTree(notebookUri);
      }),
    );

    yield* Effect.logInfo("Packages view initialized");
  }),
);
