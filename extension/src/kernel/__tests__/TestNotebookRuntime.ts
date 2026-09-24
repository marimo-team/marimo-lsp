import * as NodePath from "node:path";

import {
  Context,
  Effect,
  Latch,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";

import * as TestPythonExtension from "../../__mocks__/TestPythonExtension.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import {
  makeTestMarimoClient,
  type TestCommand,
} from "../../__tests__/__utils__/TestMarimoClient.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { kernelSessionId, notebookId } from "../../lib/__tests__/branded.ts";
import * as NotebookDatasources from "../../panel/datasources/NotebookDatasources.ts";
import * as NotebookVariables from "../../panel/variables/NotebookVariables.ts";
import * as VsCode from "../../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookId,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { KernelSessionId } from "../../schemas/Models.gen.ts";
import type {
  DocumentAnalysis,
  KernelNotification,
  MarimoSessionsChanged,
} from "../../types.ts";
import * as CellOutputProjections from "../CellOutputProjections.ts";
import * as NotebookRuntime from "../NotebookRuntime.ts";
import { PythonController } from "../PythonController.ts";
import * as VsCodeCellDrive from "../VsCodeCellDrive.ts";

export interface Interface {
  readonly vscode: TestVsCode.Interface;
  readonly editor: vscode.NotebookEditor;
  readonly notebook: MarimoNotebookDocument;
  readonly notebookUri: NotebookId;
  readonly executions: Effect.Effect<ReadonlyArray<TestCommand>>;
  readonly executionChanges: Stream.Stream<ReadonlyArray<TestCommand>>;
  readonly errors: Effect.Effect<ReadonlyArray<string>>;
  readonly inputRequested: Effect.Effect<void>;
  readonly inputCancelled: Effect.Effect<void>;
  readonly workspaceEditStarted: Effect.Effect<void>;
  readonly provideInput: (
    value: Option.Option<string>,
  ) => Effect.Effect<boolean>;
  readonly publishOperation: (
    notification: KernelNotification,
  ) => Effect.Effect<boolean>;
  readonly publishAnalysis: (
    analysis: DocumentAnalysis,
  ) => Effect.Effect<boolean>;
  readonly attachController: (notebook: NotebookId) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/NotebookRuntime",
) {}

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
      const inputQueue = yield* Queue.unbounded<Option.Option<string>>();
      const inputRequested = yield* Latch.make();
      const inputCancelled = yield* Latch.make();
      const workspaceEditStarted = yield* Latch.make();
      const executions = yield* SubscriptionRef.make<
        ReadonlyArray<TestCommand>
      >([]);
      const errorMessages = yield* Ref.make<ReadonlyArray<string>>([]);
      const operations = yield* PubSub.unbounded<KernelNotification>();
      const documentAnalysis = yield* PubSub.unbounded<DocumentAnalysis>();

      const editor = TestVsCode.makeNotebookEditor(
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

      const vscodeLayer = TestVsCode.layerWith({
        initialDocuments: [editor.notebook],
        workspace: {
          applyEdit: options.suspendWorkspaceEdits
            ? () => workspaceEditStarted.open.pipe(Effect.andThen(Effect.never))
            : () => Effect.succeed(true),
        },
        window: {
          showInputBox: () =>
            inputRequested.open.pipe(
              Effect.andThen(Queue.take(inputQueue)),
              Effect.onInterrupt(() => inputCancelled.open),
            ),
          showErrorMessage: (message) =>
            Ref.update(errorMessages, (messages) => [
              ...messages,
              message,
            ]).pipe(Effect.as(Option.none())),
        },
      });

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
        Layer.provideMerge(NotebookVariables.defaultLayer),
        Layer.provideMerge(NotebookDatasources.defaultLayer),
        Layer.provide(
          makeTestMarimoClient({
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
        Layer.provide(TestTelemetryLive),
        Layer.provide(TestPythonExtension.layer),
        Layer.provideMerge(vscodeLayer),
      );
      const environment = Layer.merge(runtimeLayer, cellDriveLayer);

      const fixtureLayer = Layer.effect(
        Service,
        Effect.gen(function* () {
          const vscode = yield* TestVsCode.Service;
          const code = yield* VsCode.Service;
          const cellDrive = yield* VsCodeCellDrive.Service;
          const runtime = yield* NotebookRuntime.Service;
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
            errors: Ref.get(errorMessages),
            inputRequested: inputRequested.await,
            inputCancelled: inputCancelled.await,
            workspaceEditStarted: workspaceEditStarted.await,
            provideInput: (value) => Queue.offer(inputQueue, value),
            publishOperation: (notification) =>
              PubSub.publish(operations, notification),
            publishAnalysis: (analysis) =>
              PubSub.publish(documentAnalysis, analysis),
            attachController: (id) =>
              runtime.attachController(id, mockController),
          });
        }),
      ).pipe(Layer.provide(environment));

      return Layer.merge(environment, fixtureLayer);
    }),
  );

export const layer = layerWith({});
