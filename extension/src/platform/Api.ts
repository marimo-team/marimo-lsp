/**
 * Public API for marimo extension.
 *
 * A partial implementation of the VS Code Jupyter extension API.
 *
 * @see https://github.com/microsoft/vscode-jupyter/blob/main/src/api.d.ts
 */

import {
  Context,
  Effect,
  Filter,
  Layer,
  Option,
  Array as ReadonlyArray,
  Stream,
} from "effect";
import type * as vscode from "vscode";

import { scratchCellNotificationsToVsCodeOutput } from "../kernel/CellExecutions.ts";
import { NotebookRuntime } from "../kernel/NotebookRuntime.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import { VsCode } from "./VsCode.ts";

type KernelStatus =
  | "unknown"
  | "starting"
  | "idle"
  | "busy"
  | "terminating"
  | "restarting"
  | "autorestarting"
  | "dead";

/**
 * Matches vscode.NotebookCellOutputItem
 */
interface OutputItem {
  mime: string;
  data: Uint8Array;
}

/**
 * Matches vscode.NotebookCellOutput
 */
interface Output {
  items: OutputItem[];
  metadata?: Record<string, unknown>;
}

interface Kernel {
  readonly status: KernelStatus;
  readonly language: string;
  executeCode(
    code: string,
    token?: vscode.CancellationToken,
  ): AsyncIterable<Output>;
}

interface Kernels {
  getKernel(uri: vscode.Uri): Promise<Kernel | undefined>;
}

export interface MarimoApi {
  experimental: {
    kernels: Kernels;
  };
}

export class Api extends Context.Service<Api>()("Api", {
  make: Effect.gen(function* () {
    const code = yield* VsCode;
    const notebooks = yield* NotebookRuntime;

    const context = yield* Effect.context();
    const runPromise = Effect.runPromiseWith(context);

    const findMarimoNotebookDocument = Effect.fn(function* (uri: vscode.Uri) {
      const notebooks = yield* code.workspace.getNotebookDocuments;
      return ReadonlyArray.findFirst(
        ReadonlyArray.getSomes(
          notebooks.map((raw) => MarimoNotebookDocument.tryFrom(raw)),
        ),
        (doc) => doc.id === uri.toString(),
      );
    });

    const getKernel = Effect.fn(function* (uri: vscode.Uri) {
      const doc = yield* findMarimoNotebookDocument(uri);

      if (Option.isNone(doc)) {
        yield* Effect.logWarning("Notebook document not found").pipe(
          Effect.annotateLogs({ uri: uri.toString() }),
        );
        return undefined;
      }

      // Just check if we have a controller.
      // TODO: Have proper statuses?
      const isKernelActive = Option.isSome(
        yield* notebooks.forNotebook(doc.value.id).getController,
      );

      if (!isKernelActive) {
        yield* Effect.logWarning("Kernel not active for notebook").pipe(
          Effect.annotateLogs({ uri: uri.toString(), docId: doc.value.id }),
        );
        return undefined;
      }

      const kernel: Kernel = {
        status: "idle",
        language: "python",
        executeCode(cellCode, token) {
          // TODO: Send "marimo.interrupt" to kernel on cancel?
          const cancelled = Effect.callback<void>((resume) => {
            if (token?.isCancellationRequested) {
              resume(Effect.void);
            }
            const disposable = token?.onCancellationRequested(() => {
              resume(Effect.void);
            });
            return Effect.sync(() => disposable?.dispose());
          });

          return notebooks
            .forNotebook(doc.value.id)
            .executeScratchpad(cellCode)
            .pipe(
              Stream.filterMap(
                Filter.fromPredicateOption((op) =>
                  scratchCellNotificationsToVsCodeOutput(op, code),
                ),
              ),
              Stream.interruptWhen(cancelled),
              Stream.toAsyncIterableWith(context),
            );
        },
      };

      return kernel;
    });

    const api: MarimoApi = {
      experimental: {
        kernels: {
          getKernel: (uri) => runPromise(getKernel(uri)),
        },
      },
    };
    return api;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
