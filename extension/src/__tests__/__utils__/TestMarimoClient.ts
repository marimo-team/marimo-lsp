import {
  Effect,
  Layer,
  Option,
  type ParseResult,
  PubSub,
  Stream,
} from "effect";

import {
  type NotebookController,
  type NotebookControllerSelection,
  type NotebookHandle,
  NotebookRuntime,
} from "../../kernel/NotebookRuntime.ts";
import { makeMarimoCommands, MarimoClient } from "../../lsp/MarimoClient.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { MarimoApiCall, MarimoOperation } from "../../types.ts";

interface Options {
  readonly execute?: (
    request: MarimoApiCall,
  ) => Effect.Effect<unknown, ParseResult.ParseError>;
  readonly operations?: () => Stream.Stream<MarimoOperation>;
  readonly initialControllers?: ReadonlyArray<NotebookControllerSelection>;
}

export function makeTestMarimoClient(options: Options = {}) {
  return Layer.succeed(MarimoClient, makeTestMarimoClientValue(options));
}

export function makeTestNotebookRuntime(options: Options = {}) {
  const client = makeTestMarimoClientValue(options);
  return Layer.merge(
    Layer.succeed(MarimoClient, client),
    Layer.scoped(
      NotebookRuntime,
      Effect.gen(function* () {
        const handles = new Map<NotebookId, NotebookHandle>();
        const controllers = new Map<NotebookId, NotebookController>(
          options.initialControllers?.map(({ notebookUri, controller }) => [
            notebookUri,
            controller,
          ]),
        );
        const selections =
          yield* PubSub.unbounded<NotebookControllerSelection>();
        yield* Effect.addFinalizer(() => PubSub.shutdown(selections));

        const forNotebook = (notebookId: NotebookId): NotebookHandle => {
          const existing = handles.get(notebookId);
          if (existing !== undefined) return existing;
          const handle: NotebookHandle = {
            id: notebookId,
            getController: () =>
              Effect.sync(() =>
                Option.fromNullable(controllers.get(notebookId)),
              ),
            executeCells: (inner, executable) =>
              client.executeCells({
                notebookUri: notebookId,
                executable,
                inner,
              }),
            executeScratchpad: () => Stream.empty,
            updateUIElements: (inner) =>
              client.updateUiElement({ notebookUri: notebookId, inner }),
            updateModel: (inner) =>
              client.setModelValue({ notebookUri: notebookId, inner }),
            invokeFunction: (inner) =>
              client.invokeFunction({ notebookUri: notebookId, inner }),
            deleteCell: (inner) =>
              client.deleteCell({ notebookUri: notebookId, inner }),
            sendStdin: (inner) =>
              client.sendStdin({ notebookUri: notebookId, inner }),
            interrupt: () =>
              client.interrupt({ notebookUri: notebookId, inner: {} }),
            close: () =>
              client.closeSession({ notebookUri: notebookId, inner: {} }),
          };
          handles.set(notebookId, handle);
          return handle;
        };

        return NotebookRuntime.make({
          attachController: (notebookId, controller) =>
            Effect.gen(function* () {
              controllers.set(notebookId, controller);
              yield* PubSub.publish(selections, {
                notebookUri: notebookId,
                controller,
              });
            }),
          controllerChanges: () => Stream.fromPubSub(selections),
          forNotebook,
        });
      }),
    ),
  );
}

function makeTestMarimoClientValue(options: Options) {
  return MarimoClient.make({
    channel: { name: "marimo-lsp-test", show() {} },
    restart: () => Effect.void,
    ...makeMarimoCommands({
      execute: options.execute ?? (() => Effect.succeed(null)),
      operations: options.operations ?? (() => Stream.never),
    }),
  });
}
