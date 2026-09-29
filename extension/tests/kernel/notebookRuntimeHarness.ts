/**
 * A live NotebookRuntime graph on the VS Code and marimo fakes, shared by the
 * runtime test files. Tests observe through the fakes; this module only owns
 * the notebook under test and the helpers that wait for runtime transitions.
 */
import * as NodePath from "node:path";

import {
  Context,
  Effect,
  Fiber,
  Latch,
  Layer,
  Logger,
  Option,
  Stream,
} from "effect";
import type * as vscode from "vscode";

import { NOTEBOOK_TYPE } from "../../src/constants.ts";
import * as CellOutputProjections from "../../src/kernel/CellOutputProjections.ts";
import * as NotebookRuntime from "../../src/kernel/NotebookRuntime.ts";
import { PythonController } from "../../src/kernel/PythonController.ts";
import * as VsCodeCellDrive from "../../src/kernel/VsCodeCellDrive.ts";
import * as NotebookDocumentSessions from "../../src/notebook/NotebookDocumentSessions.ts";
import * as NotebookEditorRegistry from "../../src/notebook/NotebookEditorRegistry.ts";
import * as NotebookDatasources from "../../src/panel/datasources/NotebookDatasources.ts";
import * as NotebookVariables from "../../src/panel/variables/NotebookVariables.ts";
import * as VsCode from "../../src/platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookId,
} from "../../src/schemas/MarimoNotebookDocument.ts";
import type { KernelSessionId } from "../../src/schemas/Models.gen.ts";
import type {
  DocumentAnalysis,
  MarimoSessionsChanged,
} from "../../src/types.ts";
import * as MarimoClientTest from "../fake/MarimoClient.ts";
import * as PythonExtensionTest from "../fake/PythonExtension.ts";
import * as TelemetryTest from "../fake/Telemetry.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import { kernelSessionId, notebookId } from "../lib/branded.ts";
import * as DocumentLifecycle from "../notebook/documentLifecycle.ts";

export interface Options {
  readonly activeSessionId?: KernelSessionId;
  /** Hold every workspace edit open; observe it with `workspaceEditStarted`. */
  readonly suspendWorkspaceEdits?: boolean;
}

/** The notebook under test, with its attached controller. */
export class Notebook extends Context.Service<
  Notebook,
  {
    readonly editor: vscode.NotebookEditor;
    readonly notebook: MarimoNotebookDocument;
    readonly notebookUri: NotebookId;
    readonly workspaceEditStarted: Latch.Latch;
    /** Messages the runtime logged at error level, in order. */
    readonly errorLogs: ReadonlyArray<string>;
    readonly attachController: (notebook: NotebookId) => Effect.Effect<void>;
  }
>()("@marimo/test/NotebookRuntime/Notebook") {}

const ACTIVE_SESSION_ID = kernelSessionId(
  "00000000-0000-4000-8000-000000000001",
);
const REPLACEMENT_SESSION_ID = kernelSessionId(
  "00000000-0000-4000-8000-000000000002",
);

export const layerWith = (options: Options) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const activeSessionId = options.activeSessionId ?? ACTIVE_SESSION_ID;
      const workspaceEditStarted = yield* Latch.make();
      const errorLogs: string[] = [];
      const captureErrors = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Error" || logLevel === "Fatal") {
          errorLogs.push(String(message));
        }
      });

      const editor = VsCodeTest.makeNotebookEditor(
        NodePath.join(process.cwd(), "notebook_mo.py"),
        {
          data: {
            cells: [
              {
                kind: 1,
                value: "name = input('Enter name: ')",
                languageId: "python",
                metadata: MarimoNotebookCell.createMetadata({
                  marimoRuntime: { stableId: "cell-1" },
                }),
              },
            ],
          },
        },
      );
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const notebookUri = notebook.id;
      const serverSessions = new Map<
        NotebookId,
        MarimoSessionsChanged["sessions"][number]
      >([
        [
          notebookUri,
          {
            sessionId: activeSessionId,
            notebookUri,
            filename: "notebook_mo.py",
            executable: "/usr/bin/python3",
            workingDirectory: process.cwd(),
            startedAt: 1,
            status: "idle",
            attached: true,
          },
        ],
      ]);

      const vscodeLayer = VsCodeTest.layerWith(
        { initialDocuments: [editor.notebook] },
        {
          workspace: {
            applyEdit: options.suspendWorkspaceEdits
              ? () =>
                  workspaceEditStarted.open.pipe(Effect.andThen(Effect.never))
              : () => Effect.succeed(true),
          },
        },
      );

      const projectionsLayer = CellOutputProjections.layer.pipe(
        Layer.provide(vscodeLayer),
      );
      const cellDriveLayer = VsCodeCellDrive.layer.pipe(
        Layer.provide(vscodeLayer),
        Layer.provide(projectionsLayer),
      );

      let revision = 0;
      const runtimeLayer = Layer.empty.pipe(
        Layer.provideMerge(NotebookRuntime.defaultLayer),
        Layer.provideMerge(NotebookDocumentSessions.layer),
        Layer.provideMerge(NotebookEditorRegistry.layer),
        Layer.provideMerge(NotebookVariables.defaultLayer),
        Layer.provideMerge(NotebookDatasources.defaultLayer),
        Layer.provideMerge(
          MarimoClientTest.layerWith({
            send(request) {
              return Effect.suspend(() => {
                if (
                  request.kind === "execute-scratchpad" ||
                  request.kind === "execute"
                ) {
                  const id = notebookId(request.notebookUri);
                  serverSessions.set(id, {
                    sessionId: activeSessionId,
                    notebookUri: id,
                    filename: NodePath.basename(request.notebookUri),
                    executable: request.executable,
                    workingDirectory: request.workingDirectory,
                    startedAt: 1,
                    status: "idle",
                    attached: true,
                  });
                }
                if (request.kind === "restart-session") {
                  const id = notebookId(request.notebookUri);
                  const current = serverSessions.get(id);
                  if (current !== undefined) {
                    serverSessions.set(id, {
                      ...current,
                      sessionId: REPLACEMENT_SESSION_ID,
                    });
                  }
                }
                return ["list-sessions", "execute", "restart-session"].includes(
                  request.kind,
                )
                  ? Effect.succeed({
                      generation: 1,
                      revision: ++revision,
                      sessions: [...serverSessions.values()],
                    })
                  : MarimoClientTest.defaultResponse(request);
              });
            },
          }),
        ),
        Layer.provide(TelemetryTest.layer),
        Layer.provide(PythonExtensionTest.layer),
        Layer.provideMerge(vscodeLayer),
        Layer.provide(Logger.layer([Logger.tracerLogger, captureErrors])),
      );
      const environment = Layer.merge(runtimeLayer, cellDriveLayer);

      const notebookLayer = Layer.effect(
        Notebook,
        Effect.gen(function* () {
          const code = yield* VsCode.Service;
          const cellDrive = yield* VsCodeCellDrive.Service;
          const runtime = yield* NotebookRuntime.Service;
          const controller = yield* code.notebooks.createNotebookController(
            "test-controller",
            NOTEBOOK_TYPE,
            "Test Controller",
          );
          const testController = new PythonController(
            controller,
            "/usr/bin/python3",
            Stream.never,
            (document) =>
              cellDrive.bind({
                notebook: document,
                controller: {
                  createNotebookCellExecution: (cell) =>
                    controller.createNotebookCellExecution(
                      cell.rawNotebookCell,
                    ),
                },
              }),
            () => Effect.void,
          );
          yield* runtime.attachController(notebookUri, testController);

          return {
            editor,
            notebook,
            notebookUri,
            workspaceEditStarted,
            errorLogs,
            attachController: (id) =>
              runtime.attachController(id, testController),
          };
        }),
      ).pipe(Layer.provide(environment));

      return Layer.merge(environment, notebookLayer);
    }),
  );

export const layer = layerWith({});

/** Makes the editor active and waits for the session and registry to agree. */
export const activate = Effect.fn("NotebookRuntimeHarness.activate")(function* (
  target: vscode.NotebookEditor,
) {
  const vscode = yield* VsCodeTest.Service;
  const sessions = yield* NotebookDocumentSessions.Service;
  const editors = yield* NotebookEditorRegistry.Service;
  const targetId = MarimoNotebookDocument.from(target.notebook).id;
  // Both observed streams deduplicate, so re-activating the active editor
  // would never emit; there is nothing to wait for in that case.
  const { activeNotebookUri } = yield* vscode.snapshot;
  if (Option.contains(activeNotebookUri, target.notebook.uri.toString())) {
    return;
  }
  const activeSession = yield* sessions.active.pipe(
    Stream.filter(
      Option.exists((session) => session.document === target.notebook),
    ),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
  const activeEditor = yield* editors.streamActiveNotebookChanges.pipe(
    Stream.filter(Option.contains(targetId)),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
  yield* vscode.setActiveNotebookEditor(Option.some(target));
  yield* Effect.all([Fiber.join(activeSession), Fiber.join(activeEditor)], {
    discard: true,
  });
});

export const open = Effect.fn("NotebookRuntimeHarness.open")(function* (
  target: vscode.NotebookEditor,
) {
  const vscode = yield* VsCodeTest.Service;
  yield* vscode.openNotebook(target.notebook);
  yield* activate(target);
});

export const close = (document: vscode.NotebookDocument) =>
  DocumentLifecycle.transition(document, "closed");

const awaitInput = (status: "pending" | "cancelled") =>
  Effect.flatMap(VsCodeTest.Service, (vscode) =>
    vscode.inputChanges.pipe(
      Stream.filter((inputs) =>
        inputs.some((input) => input.status === status),
      ),
      Stream.runHead,
      Effect.asVoid,
    ),
  );

export const inputRequested = awaitInput("pending");
export const inputCancelled = awaitInput("cancelled");

/** Publishes document analysis and waits until the runtime dispatched it. */
export const publishAnalysis = Effect.fn(
  "NotebookRuntimeHarness.publishAnalysis",
)(function* (analysis: DocumentAnalysis) {
  const runtime = yield* NotebookRuntime.Service;
  const marimo = yield* MarimoClientTest.Service;
  const dispatched = yield* runtime.subscribeInputProgress;
  const observed = yield* dispatched.pipe(
    Stream.filter(
      (input) =>
        input._tag === "AnalysisDispatched" && input.message === analysis,
    ),
    Stream.runHead,
    Effect.forkChild,
  );
  const published = yield* marimo.publishAnalysis(analysis);
  yield* Fiber.join(observed);
  return published;
}, Effect.scoped);

/** Applies a notebook change and waits until the runtime synchronized it. */
export const changeNotebook = Effect.fn(
  "NotebookRuntimeHarness.changeNotebook",
)(function* (event: vscode.NotebookDocumentChangeEvent) {
  const runtime = yield* NotebookRuntime.Service;
  const vscode = yield* VsCodeTest.Service;
  const progress = yield* runtime.subscribeInputProgress;
  const synchronized = yield* progress.pipe(
    Stream.filter(
      (input) => input._tag === "NotebookChanged" && input.event === event,
    ),
    Stream.runHead,
    Effect.forkChild,
  );
  const published = yield* vscode.notebookChange(event);
  yield* Fiber.join(synchronized);
  return published;
}, Effect.scoped);
