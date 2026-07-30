import { Effect, Layer, Stream } from "effect";

import {
  type NotebookHandle,
  NotebookRuntime,
} from "../../kernel/NotebookRuntime.ts";
import { makeMarimoCommands, MarimoClient } from "../../lsp/MarimoClient.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { MarimoApiRequest, MarimoOperation } from "../../types.ts";

interface Options {
  readonly execute?: (request: MarimoApiRequest) => Effect.Effect<unknown>;
  readonly operations?: () => Stream.Stream<MarimoOperation>;
}

export function makeTestMarimoClient(options: Options = {}) {
  return Layer.succeed(MarimoClient, makeTestMarimoClientValue(options));
}

export function makeTestNotebookRuntime(options: Options = {}) {
  const client = makeTestMarimoClientValue(options);
  const handles = new Map<NotebookId, NotebookHandle>();
  const forNotebook = (notebookId: NotebookId): NotebookHandle => {
    const existing = handles.get(notebookId);
    if (existing !== undefined) return existing;
    const handle: NotebookHandle = {
      id: notebookId,
      executeCells: (inner, executable) =>
        client.executeCells({ notebookUri: notebookId, executable, inner }),
      executeScratchpad: () => Stream.empty,
      updateUIElements: (inner) =>
        client.updateUIElements({ notebookUri: notebookId, inner }),
      updateModel: (inner) =>
        client.updateModel({ notebookUri: notebookId, inner }),
      invokeFunction: (inner) =>
        client.invokeFunction({ notebookUri: notebookId, inner }),
      deleteCell: (inner) =>
        client.deleteCell({ notebookUri: notebookId, inner }),
      sendStdin: (inner) =>
        client.sendStdin({ notebookUri: notebookId, inner }),
      interrupt: () => client.interrupt({ notebookUri: notebookId, inner: {} }),
      close: () => client.closeSession({ notebookUri: notebookId, inner: {} }),
    };
    handles.set(notebookId, handle);
    return handle;
  };

  return Layer.merge(
    Layer.succeed(MarimoClient, client),
    Layer.succeed(
      NotebookRuntime,
      NotebookRuntime.make({
        selectController: () => Effect.void,
        forNotebook,
      }),
    ),
  );
}

function makeTestMarimoClientValue(options: Options) {
  return MarimoClient.make({
    channel: { name: "marimo-lsp-test", show() {} },
    restart: () => Effect.void,
    ...makeMarimoCommands({
      execute: options.execute ?? (() => Effect.void),
      operations: options.operations ?? (() => Stream.never),
    }),
  });
}
