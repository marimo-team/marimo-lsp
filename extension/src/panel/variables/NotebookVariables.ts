import {
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  PubSub,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";

import * as NotebookDocumentSessions from "../../notebook/NotebookDocumentSessions.ts";
import {
  decodeVariablesOperation,
  type NotebookId,
} from "../../schemas/MarimoNotebookDocument.ts";
import type {
  VariablesNotification,
  VariableValuesNotification,
  VariableName,
} from "../../types.ts";

type VariableStateKey = readonly [
  notebookId: NotebookId,
  sessionId: NotebookDocumentSessions.Session["id"],
];

const keyFor = (
  session: NotebookDocumentSessions.Session,
): VariableStateKey => [session.notebookId, session.id];

export type Variables = ReturnType<typeof decodeVariablesOperation>;
export type Values = Array<VariableValuesNotification["variables"][number]>;
export interface Update {
  readonly notebookId: NotebookId;
  readonly kind: "declaration" | "values";
}

export interface Interface {
  readonly updateVariables: (
    session: NotebookDocumentSessions.Session,
    operation: VariablesNotification,
  ) => Effect.Effect<void>;
  readonly updateVariableValues: (
    session: NotebookDocumentSessions.Session,
    operation: VariableValuesNotification,
  ) => Effect.Effect<void>;
  readonly getVariables: (
    notebookUri: NotebookId,
  ) => Effect.Effect<Option.Option<Variables>>;
  readonly getVariableValues: (
    notebookUri: NotebookId,
  ) => Effect.Effect<Option.Option<Values>>;
  readonly getAllVariableData: (notebookUri: NotebookId) => Effect.Effect<{
    readonly variables: Option.Option<Variables>;
    readonly values: Option.Option<Values>;
  }>;
  readonly streamVariablesChanges: Stream.Stream<
    HashMap.HashMap<NotebookId, VariablesNotification>
  >;
  readonly streamVariableValuesChanges: Stream.Stream<
    HashMap.HashMap<NotebookId, VariableValuesNotification>
  >;
  readonly notebookUpdates: Stream.Stream<Update>;
}

/**
 * Manages variable state across all notebooks.
 *
 * Tracks:
 * 1. Variable declarations (variables operation) - which cells declare/use variables
 * 2. Variable values (variable-values operation) - current values of variables
 *
 * Uses SubscriptionRef for reactive state management.
 */
export class Service extends Context.Service<Service, Interface>()(
  "@marimo/NotebookVariables",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const documentSessions = yield* NotebookDocumentSessions.Service;

    // Track variable declarations by exact document opening.
    const variablesRef = yield* SubscriptionRef.make(
      HashMap.empty<VariableStateKey, VariablesNotification>(),
    );

    // Track variable values by exact document opening.
    const variableValuesRef = yield* SubscriptionRef.make(
      HashMap.empty<VariableStateKey, VariableValuesNotification>(),
    );

    const registeredSessionCleanups =
      new WeakSet<NotebookDocumentSessions.Session>();

    const releaseSession = Effect.fn("NotebookVariables.releaseSession")(
      function* (session: NotebookDocumentSessions.Session) {
        const notebookUri = session.notebookId;
        registeredSessionCleanups.delete(session);
        yield* SubscriptionRef.update(
          variablesRef,
          HashMap.remove(keyFor(session)),
        );
        yield* SubscriptionRef.update(
          variableValuesRef,
          HashMap.remove(keyFor(session)),
        );

        yield* Effect.logTrace("Released variable data").pipe(
          Effect.annotateLogs({ notebookUri }),
        );
      },
    );

    const registerSessionCleanup = Effect.fn(
      "NotebookVariables.registerSessionCleanup",
    )(function* (session: NotebookDocumentSessions.Session) {
      if (registeredSessionCleanups.has(session)) return;
      registeredSessionCleanups.add(session);
      yield* Scope.addFinalizer(session.scope, releaseSession(session));
    });

    // PubSub to notify when any notebook's variables change
    const notebookUpdatesPubSub = yield* PubSub.unbounded<Update>();

    /**
     * Get variable declarations for a notebook
     */
    const getVariables = Effect.fn("NotebookVariables.getVariables")(function* (
      notebookUri: NotebookId,
    ) {
      const map = yield* SubscriptionRef.get(variablesRef);
      return Option.flatMap(documentSessions.current(notebookUri), (session) =>
        Option.map(HashMap.get(map, keyFor(session)), (operation) =>
          decodeVariablesOperation(operation),
        ),
      );
    });

    const getVariableValues = Effect.fn("NotebookVariables.getVariableValues")(
      function* (notebookUri: NotebookId) {
        const map = yield* SubscriptionRef.get(variableValuesRef);
        return Option.flatMap(
          documentSessions.current(notebookUri),
          (session) =>
            Option.map(HashMap.get(map, keyFor(session)), (operation) => [
              ...operation.variables,
            ]),
        );
      },
    );

    const projectCurrent = <A>(state: HashMap.HashMap<VariableStateKey, A>) => {
      let projection = HashMap.empty<NotebookId, A>();
      for (const [[notebookId, sessionId], value] of state) {
        if (
          Option.exists(
            documentSessions.current(notebookId),
            (session) => session.id === sessionId,
          )
        ) {
          projection = HashMap.set(projection, notebookId, value);
        }
      }
      return projection;
    };

    const updateVariables = Effect.fn("NotebookVariables.updateVariables")(
      function* (
        session: NotebookDocumentSessions.Session,
        operation: VariablesNotification,
      ) {
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const notebookUri = session.notebookId;
            yield* SubscriptionRef.update(variablesRef, (map) =>
              HashMap.set(map, keyFor(session), operation),
            );

            // Filter variable values to only include variables that exist in declarations
            const valuesMap = yield* SubscriptionRef.get(variableValuesRef);
            const existingValues = HashMap.get(valuesMap, keyFor(session));

            if (Option.isSome(existingValues)) {
              const declaredVarNames = new Set(
                operation.variables.map((v) => v.name),
              );
              const filteredValues = existingValues.value.variables.filter(
                (v) => {
                  // @ts-expect-error - should be able to remove in once branded types are fully fixed in marimo main
                  const varName: VariableName = v.name;
                  return declaredVarNames.has(varName);
                },
              );

              yield* SubscriptionRef.update(variableValuesRef, (map) =>
                HashMap.set(map, keyFor(session), {
                  ...existingValues.value,
                  variables: filteredValues,
                }),
              );
            }

            // Register after mutation: adding a finalizer to an already-closed
            // scope runs it immediately, so late writes cannot repopulate state.
            yield* registerSessionCleanup(session);

            yield* PubSub.publish(notebookUpdatesPubSub, {
              notebookId: notebookUri,
              kind: "declaration" as const,
            });

            yield* Effect.logTrace("Updated variable declarations").pipe(
              Effect.annotateLogs({
                notebookUri,
                count: operation.variables.length,
              }),
            );
          }),
        );
      },
    );

    const updateVariableValues = Effect.fn(
      "NotebookVariables.updateVariableValues",
    )(function* (
      session: NotebookDocumentSessions.Session,
      operation: VariableValuesNotification,
    ) {
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const notebookUri = session.notebookId;
          yield* SubscriptionRef.update(variableValuesRef, (map) =>
            HashMap.set(map, keyFor(session), operation),
          );
          yield* registerSessionCleanup(session);

          yield* PubSub.publish(notebookUpdatesPubSub, {
            notebookId: notebookUri,
            kind: "values" as const,
          });

          yield* Effect.logTrace("Updated variable values").pipe(
            Effect.annotateLogs({
              notebookUri,
              count: operation.variables.length,
            }),
          );
        }),
      );
    });

    const getAllVariableData = Effect.fn(
      "NotebookVariables.getAllVariableData",
    )(function* (notebookUri: NotebookId) {
      const variables = yield* getVariables(notebookUri);
      const values = yield* getVariableValues(notebookUri);
      return { variables, values };
    });

    return Service.of({
      updateVariables,
      updateVariableValues,
      getVariables,
      getVariableValues,
      getAllVariableData,

      /**
       * Stream of variable declaration changes.
       *
       * Emits the current value on subscription, then all subsequent changes.
       * Filters consecutive duplicates via Stream.changes.
       */
      streamVariablesChanges: SubscriptionRef.changes(variablesRef).pipe(
        Stream.map(projectCurrent),
        Stream.changes,
      ),

      /**
       * Stream of variable value changes.
       *
       * Emits the current value on subscription, then all subsequent changes.
       * Filters consecutive duplicates via Stream.changes.
       */
      streamVariableValuesChanges: SubscriptionRef.changes(
        variableValuesRef,
      ).pipe(Stream.map(projectCurrent), Stream.changes),

      /**
       * Stream of notebook IDs that had variable updates.
       *
       * Emits the NotebookId whenever variables or variable values are updated.
       * Use this for reacting to changes without needing the full data.
       */
      notebookUpdates: Stream.fromPubSub(notebookUpdatesPubSub),
    });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide(NotebookDocumentSessions.layer),
);
