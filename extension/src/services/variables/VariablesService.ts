import { Effect, HashMap, Option, Stream, SubscriptionRef } from "effect";
import { decodeVariablesOperation, type NotebookId } from "../../schemas.ts";
import type {
  VariablesNotification,
  VariableValuesNotification,
} from "../../types.ts";
import { Log } from "../../utils/log.ts";

// Re-export for others using this service
export type { VariableName } from "../../schemas.ts";

/**
 * Manages variable state across all notebooks.
 *
 * Tracks:
 * 1. Variable declarations (variables operation) - which cells declare/use variables
 * 2. Variable values (variable-values operation) - current values of variables
 *
 * Uses SubscriptionRef for reactive state management.
 */
export class VariablesService extends Effect.Service<VariablesService>()(
  "VariablesService",
  {
    scoped: Effect.gen(function* () {
      // Track variable declarations: NotebookUri -> VariablesOp
      const variablesRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, VariablesNotification>(),
      );

      // Track variable values: NotebookUri -> VariableValuesOp
      const variableValuesRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, VariableValuesNotification>(),
      );

      /**
       * Get variable declarations for a notebook
       */
      function getVariables(notebookUri: NotebookId) {
        return Effect.gen(function* () {
          const map = yield* SubscriptionRef.get(variablesRef);
          const op = HashMap.get(map, notebookUri);
          return Option.map(op, (o) => decodeVariablesOperation(o));
        });
      }

      function getVariableValues(notebookUri: NotebookId) {
        return Effect.gen(function* () {
          const map = yield* SubscriptionRef.get(variableValuesRef);
          const op = HashMap.get(map, notebookUri);
          return Option.map(op, (o) => [...o.variables] as const);
        });
      }

      return {
        /**
         * Update variable declarations for a notebook
         */
        updateVariables(
          notebookUri: NotebookId,
          operation: VariablesNotification,
        ) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(variablesRef, (map) =>
              HashMap.set(map, notebookUri, operation),
            );

            // Filter variable values to only include variables that exist in declarations
            const valuesMap = yield* SubscriptionRef.get(variableValuesRef);
            const existingValues = HashMap.get(valuesMap, notebookUri);

            if (Option.isSome(existingValues)) {
              const declaredVarNames = new Set(
                operation.variables.map((v) => v.name),
              );
              const filteredValues = existingValues.value.variables.filter(
                (v) => declaredVarNames.has(v.name),
              );

              yield* SubscriptionRef.update(variableValuesRef, (map) =>
                HashMap.set(map, notebookUri, {
                  ...existingValues.value,
                  variables: filteredValues,
                }),
              );
            }

            yield* Log.trace("Updated variable declarations", {
              notebookUri,
              count: operation.variables.length,
            });
          });
        },

        /**
         * Update variable values for a notebook
         */
        updateVariableValues(
          notebookUri: NotebookId,
          operation: VariableValuesNotification,
        ) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(variableValuesRef, (map) =>
              HashMap.set(map, notebookUri, operation),
            );

            yield* Log.trace("Updated variable values", {
              notebookUri,
              count: operation.variables.length,
            });
          });
        },

        /**
         * Get variable declarations for a notebook
         */
        getVariables,

        /**
         * Get variable values for a notebook
         */
        getVariableValues,

        /**
         * Get all variables and their values for a notebook
         */
        getAllVariableData(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            const variables = yield* getVariables(notebookUri);
            const values = yield* getVariableValues(notebookUri);
            return { variables, values };
          });
        },

        /**
         * Clear all variable data for a notebook
         */
        clearNotebook(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(variablesRef, (map) =>
              HashMap.remove(map, notebookUri),
            );
            yield* SubscriptionRef.update(variableValuesRef, (map) =>
              HashMap.remove(map, notebookUri),
            );

            yield* Log.trace("Cleared variable data", { notebookUri });
          });
        },

        /**
         * Stream of variable declaration changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         * Filters consecutive duplicates via Stream.changes.
         */
        streamVariablesChanges() {
          return variablesRef.changes.pipe(Stream.changes);
        },

        /**
         * Stream of variable value changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         * Filters consecutive duplicates via Stream.changes.
         */
        streamVariableValuesChanges() {
          return variableValuesRef.changes.pipe(Stream.changes);
        },
      };
    }),
  },
) {}
