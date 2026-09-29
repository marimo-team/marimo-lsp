import {
  Context,
  Effect,
  Latch,
  Layer,
  Option,
  PubSub,
  Ref,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import type * as vscode from "vscode";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import {
  makeTestNotebookRuntime,
  type TestCommand,
} from "../../__tests__/__utils__/TestMarimoClient.ts";
import type * as NotebookRuntime from "../../kernel/NotebookRuntime.ts";
import { kernelSessionId } from "../../lib/__tests__/branded.ts";
import * as Workspace from "../../platform/Workspace.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { KernelNotification } from "../../types.ts";
import * as AutoExport from "../AutoExport.ts";

const controller: NotebookRuntime.NotebookController = {
  id: "test-controller",
  drive: () => () => Effect.void,
  presentOutputs: () => Effect.void,
  resolveExecutable: () => Effect.succeed("/usr/bin/python"),
};

const sessionId = kernelSessionId("00000000-0000-4000-8000-000000000001");

export interface Options {
  readonly autoDownload?: ReadonlyArray<AutoExport.Format>;
  readonly hasOutputs?: boolean;
  readonly hasRuntimeSession?: boolean;
  readonly blockHtmlExport?: boolean;
}

export interface Snapshot {
  readonly requests: ReadonlyArray<TestCommand>;
  readonly writes: ReadonlyMap<string, string>;
  readonly directories: ReadonlyArray<string>;
}

export interface Interface {
  readonly snapshot: Effect.Effect<Snapshot>;
  readonly activate: Effect.Effect<void>;
  readonly showAnotherEditor: Effect.Effect<void>;
  readonly tick: Effect.Effect<void>;
  readonly completeRun: Effect.Effect<void>;
  readonly addOutput: Effect.Effect<void>;
  readonly reopen: Effect.Effect<void>;
  readonly htmlExportStarted: Effect.Effect<void>;
  readonly releaseHtmlExport: Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/AutoExport",
) {}

const output = () => ({
  items: [
    {
      data: new TextEncoder().encode("2"),
      mime: "text/plain",
    },
  ],
});

const makeEditor = (
  autoDownload: ReadonlyArray<AutoExport.Format>,
  outputs: vscode.NotebookCellOutput[],
  value = "1 + 1",
) =>
  TestVsCode.makeNotebookEditor("/test/report.py", {
    data: {
      metadata: MarimoNotebookDocument.createMetadata({
        appOptions: {
          managed: { autoDownload: [...autoDownload] },
          passthrough: {},
        },
      }),
      cells: [
        {
          kind: 2,
          value,
          languageId: "python",
          metadata: MarimoNotebookCell.createMetadata({
            marimoRuntime: { stableId: "cell-1" },
          }),
          outputs,
        },
      ],
    },
  });

export const layerWith = (options: Options) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<TestCommand>>([]);
      const writes = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const directories = yield* Ref.make<ReadonlyArray<string>>([]);
      const operations = yield* PubSub.unbounded<KernelNotification>();
      const htmlExportStarted = yield* Latch.make();
      const releaseHtmlExport = yield* Latch.make();

      const formats = options.autoDownload ?? ["html", "ipynb"];
      const cellOutputs = options.hasOutputs === false ? [] : [output()];
      const editor = makeEditor(formats, cellOutputs);
      const notebook = MarimoNotebookDocument.from(editor.notebook);

      const vscodeLayer = TestVsCode.layerWith(
        {
          initialDocuments: [editor.notebook],
        },
        {
          workspace: {
            fs: {
              createDirectory: (uri) =>
                Ref.update(directories, (current) => [
                  ...current,
                  uri.toString(),
                ]),
              readFile: (uri) =>
                Effect.fail(
                  new Workspace.FileSystemError({
                    cause: new Error(`ENOENT: ${uri.toString()}`),
                  }),
                ),
              writeFile: (uri, contents) =>
                Ref.update(writes, (current) => {
                  const next = new Map(current);
                  next.set(uri.toString(), new TextDecoder().decode(contents));
                  return next;
                }),
            },
          },
        },
      );
      const runtimeLayer = makeTestNotebookRuntime({
        initialControllers: [{ notebookUri: notebook.id, controller }],
        runtimeSession:
          options.hasRuntimeSession === false
            ? undefined
            : { executable: "/usr/bin/python", workingDirectory: "/test" },
        kernelNotifications: Stream.fromPubSub(operations),
        send: (request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(
            Effect.andThen(
              request.kind === "export-html" && options.blockHtmlExport
                ? htmlExportStarted.open.pipe(
                    Effect.andThen(releaseHtmlExport.await),
                    Effect.as("<html>old report</html>"),
                  )
                : Effect.succeed(
                    request.kind === "export-html"
                      ? "<html>report</html>"
                      : request.kind === "export-markdown"
                        ? "# Report"
                        : "{}",
                  ),
            ),
          ),
      });
      const environment = AutoExport.layer.pipe(
        Layer.provide(runtimeLayer),
        Layer.provideMerge(vscodeLayer),
      );
      const fixture = Layer.effect(
        Service,
        Effect.gen(function* () {
          const vscode = yield* TestVsCode.Service;
          return Service.of({
            snapshot: Effect.all({
              requests: Ref.get(requests),
              writes: Ref.get(writes),
              directories: Ref.get(directories),
            }),
            activate: vscode.setActiveNotebookEditor(Option.some(editor)),
            showAnotherEditor: Effect.suspend(() =>
              vscode.setActiveNotebookEditor(
                Option.some(
                  TestVsCode.createTestNotebookEditor(editor.notebook),
                ),
              ),
            ),
            tick: TestClock.adjust(AutoExport.interval),
            completeRun: PubSub.publish(operations, {
              notebookUri: notebook.id,
              sessionId,
              notification: { op: "completed-run", run_id: null },
            }).pipe(Effect.asVoid),
            addOutput: Effect.sync(() => {
              cellOutputs.push(output());
            }),
            reopen: Effect.gen(function* () {
              yield* vscode.setActiveNotebookEditor(Option.none());
              yield* vscode.closeNotebook(editor.notebook);
              const reopened = makeEditor(formats, cellOutputs, "2 + 2");
              yield* vscode.openNotebook(reopened.notebook);
              yield* vscode.setActiveNotebookEditor(Option.some(reopened));
            }),
            htmlExportStarted: htmlExportStarted.await,
            releaseHtmlExport: releaseHtmlExport.open.pipe(Effect.asVoid),
          });
        }),
      ).pipe(Layer.provide(environment));

      return Layer.merge(environment, fixture);
    }),
  );

export const layer = layerWith({});
