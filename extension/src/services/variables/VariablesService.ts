import { Effect, HashMap, Stream, SubscriptionRef } from "effect";
import type {
  NotebookUri,
  VariablesOp,
  VariableValuesOp,
} from "../../types.ts";
import { Log } from "../../utils/log.ts";

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
        HashMap.empty<NotebookUri, VariablesOp>(),
      );

      // Track variable values: NotebookUri -> VariableValuesOp
      const variableValuesRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookUri, VariableValuesOp>(),
      );

      return {
        /**
         * Update variable declarations for a notebook
         */
        updateVariables(notebookUri: NotebookUri, operation: VariablesOp) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(variablesRef, (map) =>
              HashMap.set(map, notebookUri, operation),
            );

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
          notebookUri: NotebookUri,
          operation: VariableValuesOp,
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
        getVariables(notebookUri: NotebookUri) {
          return Effect.gen(function* () {
            const map = yield* SubscriptionRef.get(variablesRef);
            return HashMap.get(map, notebookUri);
          });
        },

        /**
         * Get variable values for a notebook
         */
        getVariableValues(notebookUri: NotebookUri) {
          return Effect.gen(function* () {
            const map = yield* SubscriptionRef.get(variableValuesRef);
            return HashMap.get(map, notebookUri);
          });
        },

        /**
         * Get all variables and their values for a notebook
         */
        getAllVariableData(notebookUri: NotebookUri) {
          return Effect.gen(function* () {
            const variablesMap = yield* SubscriptionRef.get(variablesRef);
            const valuesMap = yield* SubscriptionRef.get(variableValuesRef);

            return {
              variables: HashMap.get(variablesMap, notebookUri),
              values: HashMap.get(valuesMap, notebookUri),
            };
          });
        },

        /**
         * Clear all variable data for a notebook
         */
        clearNotebook(notebookUri: NotebookUri) {
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
         * Stream of variable declaration changes
         */
        streamVariablesChanges() {
          return variablesRef.changes;
        },

        /**
         * Stream of variable value changes
         */
        streamVariableValuesChanges() {
          return variableValuesRef.changes;
        },
      };
    }),
  },
) {}
