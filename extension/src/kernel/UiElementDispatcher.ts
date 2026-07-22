import { Effect, HashMap, Option, Ref, Scope } from "effect";

import type { NotebookId } from "../schemas/MarimoNotebookDocument.ts";
import type { UIElementId, UpdateUIElementRequest } from "../types.ts";

const NonEmptyUiPatchTypeId: unique symbol = Symbol("NonEmptyUiPatch");

/** A last-write-wins collection containing at least one UI element update. */
interface NonEmptyUiPatch {
  readonly [NonEmptyUiPatchTypeId]: typeof NonEmptyUiPatchTypeId;
  readonly values: HashMap.HashMap<UIElementId, unknown>;
}

/**
 * A lane exists if and only if it has one request in flight.
 *
 * Absence from the lanes map represents idle, making "idle with pending work"
 * unrepresentable. Pending is optional, but when present is guaranteed non-empty.
 */
interface ActiveUiLane {
  readonly inFlight: NonEmptyUiPatch;
  readonly pending: Option.Option<NonEmptyUiPatch>;
}

type UiLanes = HashMap.HashMap<NotebookId, ActiveUiLane>;

function nonEmptyPatch(
  values: HashMap.HashMap<UIElementId, unknown>,
): NonEmptyUiPatch {
  return { [NonEmptyUiPatchTypeId]: NonEmptyUiPatchTypeId, values };
}

function fromRequest(
  request: UpdateUIElementRequest,
): Option.Option<NonEmptyUiPatch> {
  if (
    request.objectIds.length === 0 ||
    request.objectIds.length !== request.values.length
  ) {
    return Option.none();
  }

  let values = HashMap.empty<UIElementId, unknown>();
  for (const [index, objectId] of request.objectIds.entries()) {
    values = HashMap.set(values, objectId, request.values[index]);
  }
  return Option.some(nonEmptyPatch(values));
}

function merge(
  older: NonEmptyUiPatch,
  newer: NonEmptyUiPatch,
): NonEmptyUiPatch {
  let values = older.values;
  for (const [objectId, value] of HashMap.entries(newer.values)) {
    values = HashMap.set(values, objectId, value);
  }
  return nonEmptyPatch(values);
}

function toRequest(patch: NonEmptyUiPatch): UpdateUIElementRequest {
  const entries = Array.from(HashMap.entries(patch.values));
  return {
    objectIds: entries.map(([objectId]) => objectId),
    values: entries.map(([, value]) => value),
  };
}

type SendUiElementRequest = (
  notebookId: NotebookId,
  request: UpdateUIElementRequest,
) => Effect.Effect<unknown, unknown>;

/**
 * Creates a per-notebook, single-flight dispatcher for replaceable UI state.
 *
 * At most one request is sent at a time for each notebook. Updates received
 * while it is in flight are merged by UI element ID into one pending request.
 */
export const makeUiElementDispatcher = Effect.fn(function* (
  send: SendUiElementRequest,
) {
  const lanes = yield* Ref.make<UiLanes>(HashMap.empty());

  const drain = Effect.fn(function* (
    notebookId: NotebookId,
    initial: NonEmptyUiPatch,
  ) {
    let current = initial;
    while (true) {
      yield* send(notebookId, toRequest(current)).pipe(
        Effect.catchAll((error) =>
          Effect.logError("Failed to send UI element update").pipe(
            Effect.annotateLogs({ error, notebookId }),
          ),
        ),
      );

      const next = yield* Ref.modify(lanes, (state) =>
        Option.match(HashMap.get(state, notebookId), {
          onNone: () => [Option.none<NonEmptyUiPatch>(), state] as const,
          onSome: (lane) =>
            Option.match(lane.pending, {
              onNone: () =>
                [
                  Option.none<NonEmptyUiPatch>(),
                  HashMap.remove(state, notebookId),
                ] as const,
              onSome: (pending) =>
                [
                  Option.some(pending),
                  HashMap.set(state, notebookId, {
                    inFlight: pending,
                    pending: Option.none(),
                  }),
                ] as const,
            }),
        }),
      );

      if (Option.isNone(next)) {
        return;
      }
      current = next.value;
    }
  });

  return {
    offer(
      notebookId: NotebookId,
      request: UpdateUIElementRequest,
    ): Effect.Effect<void, never, Scope.Scope> {
      return Option.match(fromRequest(request), {
        onNone: () =>
          Effect.logWarning("Dropping invalid UI element update").pipe(
            Effect.annotateLogs({
              notebookId,
              objectIdCount: request.objectIds.length,
              valueCount: request.values.length,
            }),
          ),
        onSome: (patch) =>
          Effect.gen(function* () {
            const start = yield* Ref.modify(lanes, (state) =>
              Option.match(HashMap.get(state, notebookId), {
                onNone: () =>
                  [
                    Option.some(patch),
                    HashMap.set(state, notebookId, {
                      inFlight: patch,
                      pending: Option.none(),
                    }),
                  ] as const,
                onSome: (lane) =>
                  [
                    Option.none<NonEmptyUiPatch>(),
                    HashMap.set(state, notebookId, {
                      ...lane,
                      pending: Option.some(
                        Option.match(lane.pending, {
                          onNone: () => patch,
                          onSome: (pending) => merge(pending, patch),
                        }),
                      ),
                    }),
                  ] as const,
              }),
            );

            if (Option.isSome(start)) {
              yield* drain(notebookId, start.value).pipe(
                Effect.forkScoped,
                Effect.asVoid,
              );
            }
          }),
      });
    },
  };
});
