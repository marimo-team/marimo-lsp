import * as NodePath from "node:path";

import {
  Context,
  Effect,
  Fiber,
  Latch,
  Layer,
  Option,
  PubSub,
  Stream,
  SubscriptionRef,
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
  KernelNotification,
  MarimoSessionsChanged,
} from "../../src/types.ts";
import * as MarimoClientTest from "../fake/MarimoClient.ts";
import * as PythonExtensionTest from "../fake/PythonExtension.ts";
import * as TelemetryTest from "../fake/Telemetry.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import { kernelSessionId, notebookId } from "../lib/branded.ts";
import * as DocumentLifecycle from "../notebook/documentLifecycle.ts";

export interface Interface {
  readonly vscode: VsCodeTest.Interface;
  readonly editor: vscode.NotebookEditor;
  readonly notebook: MarimoNotebookDocument;
  readonly notebookUri: NotebookId;
  readonly executions: Effect.Effect<ReadonlyArray<MarimoClientTest.Command>>;
  readonly executionChanges: Stream.Stream<
    ReadonlyArray<MarimoClientTest.Command>
  >;
  readonly errors: Effect.Effect<ReadonlyArray<string>>;
  readonly inputRequested: Effect.Effect<void>;
  readonly inputCancelled: Effect.Effect<void>;
  readonly workspaceEditStarted: Effect.Effect<void>;
  readonly activate: Effect.Effect<void>;
  readonly open: (editor: vscode.NotebookEditor) => Effect.Effect<void>;
  readonly close: (document: vscode.NotebookDocument) => Effect.Effect<void>;
  readonly provideInput: (value: Option.Option<string>) => Effect.Effect<void>;
  readonly publishOperation: (
    notification: KernelNotification,
  ) => Effect.Effect<boolean>;
  readonly publishAnalysis: (
    analysis: DocumentAnalysis,
  ) => Effect.Effect<boolean>;
  readonly changeNotebook: (
    event: vscode.NotebookDocumentChangeEvent,
  ) => Effect.Effect<boolean>;
  readonly attachController: (notebook: NotebookId) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/NotebookRuntime",
) {}

export const activate = Effect.fn("TestNotebookRuntime.activate")(function* (
  target: vscode.NotebookEditor,
) {
  const vscode = yield* VsCodeTest.Service;
  const sessions = yield* NotebookDocumentSessions.Service;
  const editors = yield* NotebookEditorRegistry.Service;
  const targetId = MarimoNotebookDocument.from(target.notebook).id;
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

export const open = Effect.fn("TestNotebookRuntime.open")(function* (
  target: vscode.NotebookEditor,
) {
  const vscode = yield* VsCodeTest.Service;
  yield* vscode.openNotebook(target.notebook);
  yield* activate(target);
});

export const close = (document: vscode.NotebookDocument) =>
  DocumentLifecycle.transition(document, "closed");

export interface Options {
  readonly activeSessionId?: KernelSessionId;
  readonly suspendWorkspaceEdits?: boolean;
}

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
      const executions = yield* SubscriptionRef.make<
        ReadonlyArray<MarimoClientTest.Command>
      >([]);
      const operations = yield* PubSub.unbounded<KernelNotification>();
      const documentAnalysis = yield* PubSub.unbounded<DocumentAnalysis>();

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
        {
          initialDocuments: [editor.notebook],
        },
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
        Layer.provide(
          MarimoClientTest.layerWith({
            send(request) {
              return Effect.gen(function* () {
                yield* SubscriptionRef.update(executions, (current) => [
                  ...current,
                  request,
                ]);
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
                  ? {
                      generation: 1,
                      revision: ++revision,
                      sessions: [...serverSessions.values()],
                    }
                  : null;
              });
            },
            kernelNotifications: Stream.fromPubSub(operations),
            documentAnalysis: Stream.fromPubSub(documentAnalysis),
          }),
        ),
        Layer.provide(TelemetryTest.layer),
        Layer.provide(PythonExtensionTest.layer),
        Layer.provideMerge(vscodeLayer),
      );
      const environment = Layer.merge(runtimeLayer, cellDriveLayer);

      const fixtureLayer = Layer.effect(
        Service,
        Effect.gen(function* () {
          const vscode = yield* VsCodeTest.Service;
          const code = yield* VsCode.Service;
          const cellDrive = yield* VsCodeCellDrive.Service;
          const runtime = yield* NotebookRuntime.Service;
          const sessions = yield* NotebookDocumentSessions.Service;
          const editors = yield* NotebookEditorRegistry.Service;
          const controller = yield* code.notebooks.createNotebookController(
            "test-controller",
            NOTEBOOK_TYPE,
            "Test Controller",
          );
          const mockController = new PythonController(
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
          yield* runtime.attachController(notebookUri, mockController);

          return Service.of({
            vscode,
            editor,
            notebook,
            notebookUri,
            executions: SubscriptionRef.get(executions),
            executionChanges: SubscriptionRef.changes(executions),
            errors: Effect.map(
              vscode.snapshot,
              (snapshot) => snapshot.errorMessages,
            ),
            inputRequested: vscode.inputChanges.pipe(
              Stream.filter((inputs) =>
                inputs.some((input) => input.status === "pending"),
              ),
              Stream.runHead,
              Effect.asVoid,
            ),
            inputCancelled: vscode.inputChanges.pipe(
              Stream.filter((inputs) =>
                inputs.some((input) => input.status === "cancelled"),
              ),
              Stream.runHead,
              Effect.asVoid,
            ),
            workspaceEditStarted: workspaceEditStarted.await,
            activate: activate(editor).pipe(
              Effect.provideService(VsCodeTest.Service, vscode),
              Effect.provideService(NotebookDocumentSessions.Service, sessions),
              Effect.provideService(NotebookEditorRegistry.Service, editors),
            ),
            open: (target) =>
              open(target).pipe(
                Effect.provideService(VsCodeTest.Service, vscode),
                Effect.provideService(
                  NotebookDocumentSessions.Service,
                  sessions,
                ),
                Effect.provideService(NotebookEditorRegistry.Service, editors),
              ),
            close: (document) =>
              close(document).pipe(
                Effect.provideService(VsCodeTest.Service, vscode),
                Effect.provideService(
                  NotebookDocumentSessions.Service,
                  sessions,
                ),
              ),
            provideInput: vscode.respondToInput,
            publishOperation: (notification) =>
              PubSub.publish(operations, notification),
            publishAnalysis: (analysis) =>
              Effect.gen(function* () {
                const dispatched = yield* runtime.subscribeInputProgress;
                const observed = yield* dispatched.pipe(
                  Stream.filter(
                    (input) =>
                      input._tag === "AnalysisDispatched" &&
                      input.message === analysis,
                  ),
                  Stream.runHead,
                  Effect.forkChild,
                );
                const published = yield* PubSub.publish(
                  documentAnalysis,
                  analysis,
                );
                yield* Fiber.join(observed);
                return published;
              }).pipe(Effect.scoped),
            changeNotebook: (event) =>
              Effect.gen(function* () {
                const progress = yield* runtime.subscribeInputProgress;
                const synchronized = yield* progress.pipe(
                  Stream.filter(
                    (input) =>
                      input._tag === "NotebookChanged" && input.event === event,
                  ),
                  Stream.runHead,
                  Effect.forkChild,
                );
                const published = yield* vscode.notebookChange(event);
                yield* Fiber.join(synchronized);
                return published;
              }).pipe(Effect.scoped),
            attachController: (id) =>
              runtime.attachController(id, mockController),
          });
        }),
      ).pipe(Layer.provide(environment));

      return Layer.merge(environment, fixtureLayer);
    }),
  );

export const layer = layerWith({});
