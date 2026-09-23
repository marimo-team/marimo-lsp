import { Effect, HashMap, Layer, Option, Ref, Stream } from "effect";

import * as NotebookEditorRegistry from "../../notebook/NotebookEditorRegistry.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { VariableValuesNotification } from "../../types.ts";
import * as TreeView from "../TreeView.ts";
import * as NotebookVariables from "./NotebookVariables.ts";

interface Item {
  type: "variable";
  notebookUri: NotebookId;
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
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const treeView = yield* TreeView.Service;
    const variables = yield* NotebookVariables.Service;
    const editorRegistry = yield* NotebookEditorRegistry.Service;

    // Track the current variable items for the active notebook
    const variableItems = yield* Ref.make<readonly Item[]>([]);

    // Create the tree data provider
    const provider = yield* treeView.createTreeDataProvider({
      viewId: "marimo-explorer-variables",
      getChildren: Effect.fn("VariablesView.getChildren")(function* (
        element?: Item,
      ) {
        if (element) {
          return [];
        }
        const items = yield* Ref.get(variableItems);
        return [...items];
      }),
      getTreeItem: (element: Item) =>
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
    const refresh = Effect.gen(function* () {
      const activeNotebookUri = yield* editorRegistry.getActiveNotebookUri;

      yield* Effect.logDebug("Refreshing variables").pipe(
        Effect.annotateLogs({
          activeNotebookUri: Option.getOrElse(activeNotebookUri, () => null),
        }),
      );
      if (Option.isNone(activeNotebookUri)) {
        yield* Ref.set(variableItems, []);
        yield* provider.refresh();
        return;
      }

      const notebookUri = activeNotebookUri.value;
      const variablesData = yield* variables.getAllVariableData(notebookUri);

      // Create a map of variable values for quick lookup
      const valueMap = new Map<string, { value?: string; datatype?: string }>();
      if (Option.isSome(variablesData.values)) {
        for (const varValue of variablesData.values.value) {
          valueMap.set(varValue.name, {
            value: varValue.value ?? undefined,
            datatype: varValue.datatype ?? undefined,
          });
        }
      }

      // Build the tree items from variable declarations
      const items: Item[] = [];
      if (Option.isSome(variablesData.variables)) {
        for (const varDecl of variablesData.variables.value) {
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

      yield* Effect.logDebug("Refreshed variables").pipe(
        Effect.annotateLogs({ count: items.length }),
      );
      yield* Ref.set(variableItems, items);
      yield* provider.refresh();
    }).pipe(Effect.withSpan("VariablesView.refresh"));

    // Subscribe to active notebook changes
    yield* Effect.forkScoped(
      editorRegistry.streamActiveNotebookChanges.pipe(
        Stream.runForEach(() => refresh),
      ),
    );

    // Subscribe to variable declarations changes
    yield* Effect.forkScoped(
      variables.streamVariablesChanges.pipe(Stream.runForEach(() => refresh)),
    );

    // Subscribe to variable values changes
    const updateValues = Effect.fn("VariablesView.updateValues")(function* (
      valuesMap: HashMap.HashMap<NotebookId, VariableValuesNotification>,
    ) {
      const activeNotebookUri = yield* editorRegistry.getActiveNotebookUri;

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
        const varValue = values.variables.find((v) => v.name === item.name);
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
    });

    yield* Effect.forkScoped(
      variables.streamVariableValuesChanges.pipe(
        Stream.runForEach(updateValues),
      ),
    );

    yield* Effect.logDebug("Variables view initialized");
  }).pipe(Effect.withSpan("VariablesView.layer")),
);
