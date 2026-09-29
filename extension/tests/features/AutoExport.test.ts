import * as Vitest from "@effect/vitest";
import { Context, Effect, Fiber, Latch, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import type * as vscode from "vscode";

import * as AutoExport from "../../src/features/AutoExport.ts";
import type * as NotebookRuntime from "../../src/kernel/NotebookRuntime.ts";
import * as VsCode from "../../src/platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../../src/schemas/MarimoNotebookDocument.ts";
import * as MarimoClientTest from "../fake/MarimoClient.ts";
import * as NotebookRuntimeTest from "../fake/NotebookRuntime.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import { kernelSessionId } from "../lib/branded.ts";
import * as EffectTest from "../lib/EffectTest.ts";

Vitest.describe("outputUri", () => {
  const it = EffectTest.make(VsCodeTest.layer);

  it.effect(
    "writes beside the notebook under __marimo__",
    Effect.fn(function* () {
      const code = yield* VsCode.Service;
      const document = VsCodeTest.createTestNotebookDocument("/test/report.py");
      const notebook = MarimoNotebookDocument.from(document);

      const uri = AutoExport.outputUri(code, notebook, "html");

      Vitest.expect(uri.path).toBe("/test/__marimo__/report.html");
    }),
  );
});

const controller: NotebookRuntime.NotebookController = {
  id: "test-controller",
  drive: () => () => Effect.void,
  presentOutputs: () => Effect.void,
  resolveExecutable: () => Effect.succeed("/usr/bin/python"),
};

const sessionId = kernelSessionId("00000000-0000-4000-8000-000000000001");

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
  VsCodeTest.makeNotebookEditor("/test/report.py", {
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

interface Options {
  readonly autoDownload?: ReadonlyArray<AutoExport.Format>;
  readonly hasOutputs?: boolean;
  readonly hasRuntimeSession?: boolean;
  readonly blockHtmlExport?: boolean;
}

/** The notebook under test and the gate that holds an HTML export open. */
class Notebook extends Context.Service<
  Notebook,
  {
    readonly editor: vscode.NotebookEditor;
    readonly formats: ReadonlyArray<AutoExport.Format>;
    readonly cellOutputs: vscode.NotebookCellOutput[];
    readonly htmlExportStarted: Latch.Latch;
    readonly releaseHtmlExport: Latch.Latch;
  }
>()("@marimo/test/AutoExport/Notebook") {}

const layerWith = (options: Options = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const htmlExportStarted = yield* Latch.make();
      const releaseHtmlExport = yield* Latch.make();
      const formats = options.autoDownload ?? ["html", "ipynb"];
      const cellOutputs = options.hasOutputs === false ? [] : [output()];
      const editor = makeEditor(formats, cellOutputs);
      const notebook = MarimoNotebookDocument.from(editor.notebook);

      const runtimeLayer = NotebookRuntimeTest.layerWith({
        initialControllers: [{ notebookUri: notebook.id, controller }],
        runtimeSession:
          options.hasRuntimeSession === false
            ? undefined
            : { executable: "/usr/bin/python", workingDirectory: "/test" },
        send: (request) =>
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
      });

      return Layer.merge(
        AutoExport.layer.pipe(
          Layer.provideMerge(runtimeLayer),
          Layer.provideMerge(
            VsCodeTest.layerWith({ initialDocuments: [editor.notebook] }),
          ),
        ),
        Layer.succeed(Notebook, {
          editor,
          formats,
          cellOutputs,
          htmlExportStarted,
          releaseHtmlExport,
        }),
      );
    }),
  );

const activate = Effect.gen(function* () {
  const { editor } = yield* Notebook;
  const vscode = yield* VsCodeTest.Service;
  yield* vscode.setActiveNotebookEditor(Option.some(editor));
});

const tick = TestClock.adjust(AutoExport.interval);

const completeRun = Effect.gen(function* () {
  const { editor } = yield* Notebook;
  const marimo = yield* MarimoClientTest.Service;
  yield* marimo.publishNotification({
    notebookUri: MarimoNotebookDocument.from(editor.notebook).id,
    sessionId,
    notification: { op: "completed-run", run_id: null },
  });
});

/**
 * Closes the notebook and opens a fresh document at the same path while the
 * previous document's export is still in flight. The reopened notebook must
 * be exported again rather than credited with that export.
 */
const reopen = Effect.gen(function* () {
  const { editor, formats, cellOutputs } = yield* Notebook;
  const vscode = yield* VsCodeTest.Service;
  yield* vscode.setActiveNotebookEditor(Option.none());
  yield* vscode.closeNotebook(editor.notebook);
  const reopened = makeEditor(formats, cellOutputs, "2 + 2");
  yield* vscode.openNotebook(reopened.notebook);
  yield* vscode.setActiveNotebookEditor(Option.some(reopened));
});

const exportKinds = Effect.gen(function* () {
  const marimo = yield* MarimoClientTest.Service;
  return (yield* marimo.commands).map((request) => request.kind);
});

Vitest.describe("AutoExport", () => {
  const it = EffectTest.make(layerWith());

  it.effect(
    "exports enabled formats once per live-session generation",
    Effect.fn(function* () {
      const vscode = yield* VsCodeTest.Service;
      yield* activate;
      yield* tick;

      const first = yield* vscode.snapshot;
      Vitest.expect(yield* exportKinds).toEqual([
        "export-html",
        "export-ipynb",
      ]);
      Vitest.expect(Object.fromEntries(first.files)).toEqual({
        "file:///test/__marimo__/report.html": "<html>report</html>",
        "file:///test/__marimo__/report.ipynb": "{}",
      });
      Vitest.expect(first.directories).toEqual(["file:///test/__marimo__"]);

      yield* tick;
      Vitest.expect(yield* exportKinds).toHaveLength(2);

      yield* completeRun;
      yield* tick;
      Vitest.expect(yield* exportKinds).toEqual([
        "export-html",
        "export-ipynb",
        "export-html",
        "export-ipynb",
      ]);
    }),
  );

  it.effect(
    "exports a notebook once when it has multiple visible editors",
    Effect.fn(function* () {
      const { editor } = yield* Notebook;
      const vscode = yield* VsCodeTest.Service;
      yield* activate;
      yield* vscode.setActiveNotebookEditor(
        Option.some(VsCodeTest.createTestNotebookEditor(editor.notebook)),
      );
      yield* tick;

      Vitest.expect(yield* exportKinds).toEqual([
        "export-html",
        "export-ipynb",
      ]);
    }),
  );

  Vitest.describe("with Markdown enabled", () => {
    const it = EffectTest.make(layerWith({ autoDownload: ["markdown"] }));

    it.effect(
      "exports Markdown to an md file",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        yield* activate;
        yield* tick;

        Vitest.expect(yield* exportKinds).toEqual(["export-markdown"]);
        Vitest.expect(
          Object.fromEntries((yield* vscode.snapshot).files),
        ).toEqual({ "file:///test/__marimo__/report.md": "# Report" });
      }),
    );
  });

  Vitest.describe("without a runtime session", () => {
    const it = EffectTest.make(layerWith({ hasRuntimeSession: false }));

    it.effect(
      "waits for a live runtime session before creating exports",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        yield* activate;
        yield* tick;

        const snapshot = yield* vscode.snapshot;
        Vitest.expect(yield* exportKinds).toEqual([]);
        Vitest.expect(snapshot.directories).toEqual([]);
        Vitest.expect(snapshot.files.size).toBe(0);
      }),
    );
  });

  Vitest.describe("without cell outputs", () => {
    const it = EffectTest.make(layerWith({ hasOutputs: false }));

    it.effect(
      "waits for cell output before exporting HTML",
      Effect.fn(function* () {
        const { cellOutputs } = yield* Notebook;
        yield* activate;
        yield* tick;
        Vitest.expect(yield* exportKinds).toEqual(["export-ipynb"]);

        cellOutputs.push(output());
        yield* completeRun;
        yield* tick;

        Vitest.expect(yield* exportKinds).toEqual([
          "export-ipynb",
          "export-html",
          "export-ipynb",
        ]);
      }),
    );
  });

  Vitest.describe("while an HTML export is in flight", () => {
    const it = EffectTest.make(layerWith({ blockHtmlExport: true }));

    it.effect(
      "does not credit an in-flight export to a reopened notebook",
      Effect.fn(function* () {
        const { htmlExportStarted, releaseHtmlExport } = yield* Notebook;
        yield* activate;
        const firstTick = yield* Effect.forkChild(tick);
        yield* htmlExportStarted.await;

        yield* reopen;
        yield* releaseHtmlExport.open;
        yield* Fiber.join(firstTick);
        yield* tick;

        Vitest.expect(yield* exportKinds).toEqual([
          "export-html",
          "export-ipynb",
          "export-html",
          "export-ipynb",
        ]);
      }),
    );
  });
});
