/**
 * Public API for marimo extension.
 *
 * A partial implementation of the VS Code Jupyter extension API.
 *
 * @see https://github.com/microsoft/vscode-jupyter/blob/main/src/api.d.ts
 */

import {
  Effect,
  Option,
  Array as ReadonlyArray,
  Runtime,
  Stream,
} from "effect";
import type * as vscode from "vscode";
import { MarimoNotebookDocument } from "../schemas.ts";
import { ControllerRegistry } from "./ControllerRegistry.ts";
import { scratchCellNotificationsToVsCodeOutput } from "./ExecutionRegistry.ts";
import { KernelManager } from "./KernelManager.ts";
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

export class Api extends Effect.Service<Api>()("Api", {
  scoped: Effect.gen(function* () {
    const code = yield* VsCode;
    const kernelManager = yield* KernelManager;
    const controllers = yield* ControllerRegistry;

    const runtime = yield* Effect.runtime();
    const runPromise = Runtime.runPromise(runtime);

    const findMarimoNotebookDocument = Effect.fn(function* (uri: vscode.Uri) {
      const notebooks = yield* code.workspace.getNotebookDocuments();
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
        // TODO: Add logging
        return undefined;
      }

      // Just check if we have a controller.
      // TODO: Have proper statuses?
      const isKernelActive = Option.isSome(
        yield* controllers.getActiveController(doc.value),
      );

      if (!isKernelActive) {
        // TODO: Add logging
        return undefined;
      }

      const kernel: Kernel = {
        status: "idle",
        language: "python",
        executeCode(cellCode, token) {
          // TODO: Send "marimo.interrupt" to kernel on cancel?
          const cancelled = Effect.async((resume) => {
            if (token?.isCancellationRequested) {
              resume(Effect.void);
            }
            const disposable = token?.onCancellationRequested(() => {
              resume(Effect.void);
            });
            return Effect.sync(() => disposable?.dispose());
          });

          return kernelManager.executeCodeUnsafe(doc.value.id, cellCode).pipe(
            Stream.filterMap((op) =>
              scratchCellNotificationsToVsCodeOutput(op, code),
            ),
            Stream.interruptWhen(cancelled),
            Stream.toAsyncIterableRuntime(runtime),
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
}) {}
