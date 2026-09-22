import { Context, Effect, Layer, Scope, Stream } from "effect";
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";

import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { signalFromToken } from "../lib/signalFromToken.ts";

export interface CellStatusBarItemProvider {
  readonly provideCellStatusBarItems: (
    cell: vscode.NotebookCell,
  ) => Effect.Effect<vscode.NotebookCellStatusBarItem[]>;
  readonly changes: Stream.Stream<void>;
}

export interface Interface {
  readonly createRendererMessaging: (
    rendererId: string,
  ) => Effect.Effect<vscode.NotebookRendererMessaging>;
  readonly createNotebookController: (
    id: string,
    notebookType: string,
    label: string,
  ) => Effect.Effect<
    Omit<vscode.NotebookController, "dispose">,
    never,
    Scope.Scope
  >;
  readonly registerNotebookCellStatusBarItemProvider: (
    notebookType: string,
    impl: CellStatusBarItemProvider,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/Notebooks",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const api = vscode.notebooks;
    const runPromise = Effect.runPromiseWith(yield* Effect.context());

    const createRendererMessaging = Effect.fn(
      "Notebooks.createRendererMessaging",
    )(function* (rendererId: string) {
      return yield* Effect.succeed(api.createRendererMessaging(rendererId));
    });

    const createNotebookController = Effect.fn(
      "Notebooks.createNotebookController",
    )(function* (id: string, notebookType: string, label: string) {
      return yield* acquireDisposable(() =>
        api.createNotebookController(id, notebookType, label),
      );
    });

    const registerNotebookCellStatusBarItemProvider = Effect.fn(
      "Notebooks.registerNotebookCellStatusBarItemProvider",
    )(function* (notebookType: string, impl: CellStatusBarItemProvider) {
      const emitter = yield* acquireDisposable(
        () => new vscode.EventEmitter<void>(),
      );
      yield* Effect.forkScoped(
        impl.changes.pipe(
          Stream.runForEach(() => Effect.succeed(emitter.fire())),
        ),
      );
      yield* acquireDisposable(() =>
        api.registerNotebookCellStatusBarItemProvider(notebookType, {
          onDidChangeCellStatusBarItems: emitter.event,
          provideCellStatusBarItems: (cell, token) =>
            runPromise(impl.provideCellStatusBarItems(cell), {
              signal: signalFromToken(token),
            }),
        }),
      );
    });

    return Service.of({
      createRendererMessaging,
      createNotebookController,
      registerNotebookCellStatusBarItemProvider,
    });
  }),
);
