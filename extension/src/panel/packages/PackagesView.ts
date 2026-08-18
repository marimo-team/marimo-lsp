import { Effect, Layer, Option, Ref, Scope, Stream } from "effect";

import refreshPackagesCommand from "../../commands/refreshPackages.ts";
import { NotebookRuntime } from "../../kernel/NotebookRuntime.ts";
import {
  NotebookDependencies,
  type NotebookDependencyState,
} from "../../notebook/NotebookDependencies.ts";
import {
  type NotebookDocumentSession,
  NotebookDocumentSessions,
} from "../../notebook/NotebookDocumentSessions.ts";
import { NotebookSessionResources } from "../../notebook/NotebookSessionResources.ts";
import { VsCode } from "../../platform/VsCode.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { DependencyTreeNode } from "../../schemas/Models.gen.ts";
import { TreeView } from "../TreeView.ts";

interface PackageTreeItem {
  type: "package";
  notebookUri: NotebookId;
  name: string;
  version: string | null;
  tags: readonly Record<string, string>[];
  dependencies: readonly DependencyTreeNode[];
}

interface ActiveDependencies {
  readonly session: NotebookDocumentSession;
  readonly state: NotebookDependencyState;
}

/**
 * Manages the packages tree view for the active notebook.
 *
 * Displays a hierarchical view of package dependencies as a tree.
 *
 * Subscribes to package dependency tree changes and updates the view in real-time.
 */
export const PackagesViewLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const treeView = yield* TreeView;
    const documentSessions = yield* NotebookDocumentSessions;
    const sessionResources = yield* NotebookSessionResources;
    const notebooks = yield* NotebookRuntime;
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
          return element.dependencies.map((dep) => ({
            type: "package" as const,
            notebookUri,
            name: dep.name,
            version: dep.version,
            tags: dep.tags,
            dependencies: dep.dependencies,
          }));
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

    const renderDependencies = Effect.fn(function* (
      active: Option.Option<ActiveDependencies>,
    ) {
      const items = Option.match(active, {
        onNone: () => [],
        onSome: ({ session, state }) => {
          if (state._tag !== "Loaded" || state.tree === null) return [];
          // The root is an implementation detail (`<root>`, a project
          // name, or `installed-packages`); its children are the user's
          // direct dependencies.
          return state.tree.dependencies.map((dependency) => ({
            type: "package" as const,
            notebookUri: session.notebookId,
            name: dependency.name,
            version: dependency.version,
            tags: dependency.tags,
            dependencies: dependency.dependencies,
          }));
        },
      });
      yield* Ref.set(packageItems, items);
      yield* provider.refresh();
    });

    const watchActiveDependencies = documentSessions.active.pipe(
      Stream.switchMap(
        Option.match({
          onNone: () =>
            Stream.fromEffect(
              renderDependencies(Option.none<ActiveDependencies>()),
            ),
          onSome: (session) =>
            Stream.fromEffect(
              sessionResources
                .runScoped(
                  session,
                  NotebookDependencies.pipe(
                    Effect.flatMap((dependencies) =>
                      dependencies.changes.pipe(
                        Stream.runForEach((state) =>
                          renderDependencies(
                            Option.some({
                              session,
                              state,
                            } satisfies ActiveDependencies),
                          ),
                        ),
                      ),
                    ),
                  ),
                )
                .pipe(
                  Scope.provide(session.scope),
                  Effect.catchTag(
                    "NotebookDocumentSessionEndedError",
                    () => Effect.void,
                  ),
                ),
            ),
        }),
      ),
      Stream.runDrain,
    );

    yield* Effect.forkScoped(watchActiveDependencies);

    // A dependency tree belongs to the selected environment, so a controller
    // change refreshes the resource owned by that document session.
    yield* Effect.forkScoped(
      notebooks.controllerChanges.pipe(
        Stream.runForEach(
          Effect.fn(function* ({ notebookUri }) {
            const session = documentSessions.current(notebookUri);
            if (session === undefined) return;
            yield* sessionResources
              .runScoped(
                session,
                NotebookDependencies.pipe(
                  Effect.flatMap((dependencies) => dependencies.refresh),
                ),
              )
              .pipe(
                Scope.provide(session.scope),
                Effect.catchTag(
                  "NotebookDocumentSessionEndedError",
                  () => Effect.void,
                ),
              );
          }),
        ),
      ),
    );

    // Register command to refresh packages
    yield* code.commands.register(refreshPackagesCommand);

    yield* Effect.logDebug("Packages view initialized");
  }),
);
