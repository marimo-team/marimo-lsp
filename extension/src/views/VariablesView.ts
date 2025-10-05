import { Effect, HashMap, Layer, Option, Ref, Stream } from "effect";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import { VariablesService } from "../services/variables/VariablesService.ts";
import type { NotebookUri } from "../types.ts";
import { Log } from "../utils/log.ts";
import { TreeView } from "./TreeView.ts";

interface VariableTreeItem {
  type: "variable";
  notebookUri: NotebookUri;
  name: string;
  value?: string;
  datatype?: string;
}

/**
 * Manages the variables tree view for the active notebook.
 *
 * Subscribes to variable changes and updates the tree view in real-time:
 * - When variables change: add/remove variables from the view
 * - When values change: update individual variable entries
 */
export const VariablesViewLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const treeView = yield* TreeView;
    const variablesService = yield* VariablesService;
    const editorRegistry = yield* NotebookEditorRegistry;

    // Track the current variable items for the active notebook
    const variableItems = yield* Ref.make<readonly VariableTreeItem[]>([]);

    // Create the tree data provider
    const provider = yield* treeView.createTreeDataProvider({
      viewId: "marimo-explorer-variables",
      getChildren: (element?: VariableTreeItem) =>
        Effect.gen(function* () {
          if (element) {
            return [];
          }
          const items = yield* Ref.get(variableItems);
          return [...items];
        }),
      getTreeItem: (element: VariableTreeItem) =>
        Effect.succeed({
          label: element.name,
          description: element.value ?? "<no value>",
          tooltip: `${element.name}${element.datatype ? ` (${element.datatype})` : ""}\n${element.value ?? "<no value>"}`,
          iconPath: undefined,
          contextValue: "marimoVariable",
          collapsibleState: "None" as const,
        }),
    });

    // Helper to rebuild the variables list from current state
    const refreshVariables = Effect.gen(function* () {
      const activeNotebookUri = yield* editorRegistry.getActiveNotebookUri();

      yield* Log.info("Refreshing variables", { activeNotebookUri });
      if (Option.isNone(activeNotebookUri)) {
        yield* Ref.set(variableItems, []);
        yield* provider.refresh();
        return;
      }

      const notebookUri = activeNotebookUri.value;
      const variablesData =
        yield* variablesService.getAllVariableData(notebookUri);

      // Create a map of variable values for quick lookup
      const valueMap = new Map<string, { value?: string; datatype?: string }>();
      if (Option.isSome(variablesData.values)) {
        for (const varValue of variablesData.values.value.variables) {
          valueMap.set(varValue.name, {
            value: varValue.value ?? undefined,
            datatype: varValue.datatype ?? undefined,
          });
        }
      }

      // Build the tree items from variable declarations
      const items: VariableTreeItem[] = [];
      if (Option.isSome(variablesData.variables)) {
        for (const varDecl of variablesData.variables.value.variables) {
          const valueData = valueMap.get(varDecl.name);
          items.push({
            type: "variable",
            notebookUri,
            name: varDecl.name,
            value: valueData?.value,
            datatype: valueData?.datatype,
          });
        }
      }

      yield* Log.info("Refreshed variables", { count: items.length });
      yield* Ref.set(variableItems, items);
      yield* provider.refresh();
    });

    // Subscribe to active notebook changes
    yield* Effect.forkScoped(
      editorRegistry.streamActiveNotebookChanges().pipe(
        Stream.tap(() => refreshVariables),
        Stream.runDrain,
      ),
    );

    // Subscribe to variable declarations changes
    yield* Effect.forkScoped(
      variablesService.streamVariablesChanges().pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* (_variablesMap) {
            // When variables change (declarations), rebuild the entire list
            yield* refreshVariables;
          }),
        ),
        Stream.runDrain,
      ),
    );

    // Subscribe to variable values changes
    yield* Effect.forkScoped(
      variablesService.streamVariableValuesChanges().pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* (valuesMap) {
            const activeNotebookUri =
              yield* editorRegistry.getActiveNotebookUri();

            if (Option.isNone(activeNotebookUri)) {
              return;
            }

            const notebookUri = activeNotebookUri.value;
            const maybeValues = HashMap.get(valuesMap, notebookUri);

            if (Option.isNone(maybeValues)) {
              return;
            }

            const values = maybeValues.value;
            const currentItems = yield* Ref.get(variableItems);

            // Update the values in the current items
            const updatedItems = currentItems.map((item) => {
              const varValue = values.variables.find(
                (v) => v.name === item.name,
              );
              if (varValue) {
                return {
                  ...item,
                  value: varValue.value ?? undefined,
                  datatype: varValue.datatype ?? undefined,
                };
              }
              return item;
            });

            yield* Ref.set(variableItems, updatedItems);
            yield* provider.refresh();
          }),
        ),
        Stream.runDrain,
      ),
    );

    // Initialize with current state
    yield* refreshVariables;

    yield* Effect.logInfo("Variables view initialized");
  }),
);
