import { Effect, Queue, Stream } from "effect";
import type * as vscode from "vscode";

export interface ControllerSelectionChange {
  readonly notebook: vscode.NotebookDocument;
  readonly selected: boolean;
}

/**
 * Capture controller selections immediately, including VS Code's synchronous
 * persisted-selection restore, and release the listener with its sole stream
 * consumer. The owning controller scope is a fallback if the consumer never
 * starts or is still running when the controller is disposed.
 */
export const makeControllerSelectionChanges = Effect.fn(
  "makeControllerSelectionChanges",
)(function* (
  controller: Pick<vscode.NotebookController, "onDidChangeSelectedNotebooks">,
) {
  const selections = yield* Queue.make<ControllerSelectionChange>();
  const listener = yield* Effect.sync(() =>
    controller.onDidChangeSelectedNotebooks((event) =>
      Queue.offerUnsafe(selections, event),
    ),
  );

  let closed = false;
  const close = Effect.suspend(() => {
    if (closed) return Effect.void;
    closed = true;
    return Effect.sync(() => listener.dispose()).pipe(
      Effect.andThen(Queue.shutdown(selections)),
    );
  });

  yield* Effect.addFinalizer(() => close);

  return Stream.fromQueue(selections).pipe(Stream.ensuring(close));
});
