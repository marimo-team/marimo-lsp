import type { Uri, WorkspaceFolder } from "vscode";

import { Effect, Layer, Option, Ref, Schema, Stream } from "effect";

import { MarimoNotebookDocument } from "../schemas.ts";
import { createStorageKey, Storage } from "../services/Storage.ts";
import { VsCode } from "../services/VsCode.ts";
import { type TreeItem, TreeView } from "./TreeView.ts";

interface RecentNotebook {
  uri: string;
  label: string;
  timestamp: number;
}

const MAX_RECENT_NOTEBOOKS = 20;

// Define schema for RecentNotebook
const RecentNotebookSchema = Schema.Struct({
  uri: Schema.String,
  label: Schema.String,
  timestamp: Schema.Number,
});

// Create type-safe storage key
const RECENT_NOTEBOOKS_KEY = createStorageKey(
  "marimo.recentNotebooks",
  Schema.Array(RecentNotebookSchema),
);

/**
 * Manages the recent notebooks tree view.
 */
export const RecentNotebooksLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const treeView = yield* TreeView;
    const code = yield* VsCode;
    const storage = yield* Storage;

    // Track recently opened notebooks - load from workspace storage
    const initialNotebooks = yield* storage.workspace
      .getWithDefault(RECENT_NOTEBOOKS_KEY, [])
      .pipe(
        Effect.catchTag(
          "StorageDecodeError",
          Effect.fnUntraced(function* (error) {
            yield* Effect.logWarning(
              "Failed to decode recent notebooks from storage, using empty list",
              error.cause,
            );
            return [];
          }),
        ),
      );
    const recentNotebooks =
      yield* Ref.make<readonly RecentNotebook[]>(initialNotebooks);

    // Create the tree data provider
    const provider = yield* treeView.createTreeDataProvider({
      viewId: "marimo-explorer-recents",
      getChildren: (element?: RecentNotebook) =>
        Effect.gen(function* () {
          if (element) {
            return [];
          }
          const notebooks = yield* Ref.get(recentNotebooks);
          return [...notebooks];
        }),
      getTreeItem: (element: RecentNotebook) =>
        Effect.gen(function* () {
          const uri = code.Uri.parse(element.uri);
          const workspaceFolders = Option.getOrElse(
            yield* code.workspace.getWorkspaceFolders(),
            () => [],
          );
          const workspaceFolder = workspaceFolders.find(
            (folder: WorkspaceFolder) =>
              element.uri.startsWith(folder.uri.toString()),
          );

          const description = workspaceFolder
            ? element.uri.replace(`${workspaceFolder.uri.toString()}/`, "")
            : uri.fsPath;

          const item: TreeItem = {
            label: element.label,
            description: new Date(element.timestamp).toLocaleString(),
            tooltip: `${description}\nLast opened: ${new Date(element.timestamp).toLocaleString()}`,
            iconPath: undefined, // Will use default notebook icon
            contextValue: "marimoRecentNotebook",
            command: {
              command: "vscode.open",
              title: "Open Notebook",
              arguments: [uri],
            },
            collapsibleState: "None",
            resourceUri: element.uri,
          };
          return item;
        }),
    });

    // Helper to add a notebook to recent list
    const addRecentNotebook = Effect.fnUntraced(function* (
      uri: Uri,
      document: MarimoNotebookDocument,
    ) {
      const uriString = uri.toString();
      // TODO: NodePath? or windows support?
      const label =
        uri.path.split("/").pop() || document.notebookType || "Untitled";

      const updated = yield* Ref.updateAndGet(recentNotebooks, (notebooks) => {
        // Remove existing entry if present
        const filtered = notebooks.filter((n) => n.uri !== uriString);

        // Add new entry at the beginning
        const updated: readonly RecentNotebook[] = [
          { uri: uriString, label, timestamp: Date.now() },
          ...filtered,
        ];

        // Keep only the most recent N notebooks
        return updated.slice(0, MAX_RECENT_NOTEBOOKS);
      });

      // Persist to workspace storage
      yield* storage.workspace
        .set(RECENT_NOTEBOOKS_KEY, updated)
        .pipe(
          Effect.catchAllCause((cause) =>
            Effect.logWarning("Failed to persist recent notebooks").pipe(
              Effect.annotateLogs({ cause }),
            ),
          ),
        );

      yield* provider.refresh();
    });

    // Listen for notebook open events
    yield* Effect.forkScoped(
      code.window.activeNotebookEditorChanges().pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* (maybeEditor) {
            const notebook = maybeEditor.pipe(
              Option.flatMap((editor) =>
                MarimoNotebookDocument.tryFrom(editor.notebook),
              ),
            );
            if (
              Option.isSome(notebook) &&
              notebook.value.uri.scheme === "file"
            ) {
              yield* addRecentNotebook(notebook.value.uri, notebook.value);
            }
          }),
        ),
        Stream.runDrain,
      ),
    );

    // Register command to clear recent notebooks
    yield* code.commands.registerCommand(
      "marimo.clearRecentNotebooks",
      Effect.fn(function* () {
        yield* Ref.set(recentNotebooks, []);
        yield* storage.workspace
          .set(RECENT_NOTEBOOKS_KEY, [])
          .pipe(
            Effect.catchAllCause((cause) =>
              Effect.logWarning("Failed to clear recent notebooks").pipe(
                Effect.annotateLogs({ cause }),
              ),
            ),
          );
        yield* provider.refresh();
        yield* Effect.logInfo("Cleared recent notebooks");
      }),
    );

    // Initialize with currently open notebooks
    yield* Effect.gen(function* () {
      const openNotebooks = yield* code.workspace.getNotebookDocuments();
      for (const unknownNotebook of openNotebooks) {
        const notebook = MarimoNotebookDocument.tryFrom(unknownNotebook);
        if (Option.isSome(notebook) && notebook.value.uri.scheme === "file") {
          yield* addRecentNotebook(notebook.value.uri, notebook.value);
        }
      }
    });

    yield* Effect.logInfo("Recent notebooks view initialized");
  }),
);
