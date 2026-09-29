import * as Vitest from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  configureAutoExport,
  mergeAutoDownloadFormats,
} from "../../src/commands/configureAutoExport.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../../src/schemas/MarimoNotebookDocument.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const it = EffectTest.make(VsCodeTest.layer);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const appOptions = (
  autoDownload: ReadonlyArray<string>,
  passthrough: Readonly<Record<string, unknown>> = {},
) => ({ managed: { autoDownload: [...autoDownload] }, passthrough });

const notebookFor = (
  editor: ReturnType<typeof VsCodeTest.makeNotebookEditor>,
) => MarimoNotebookDocument.tryFrom(editor.notebook);

Vitest.describe("mergeAutoDownloadFormats", () => {
  Vitest.it("updates all managed formats from the selection", () => {
    Vitest.expect(
      mergeAutoDownloadFormats(["html", "markdown"], ["ipynb"]),
    ).toEqual(["ipynb"]);
  });

  Vitest.it("uses stable format ordering", () => {
    Vitest.expect(mergeAutoDownloadFormats([], ["ipynb", "html"])).toEqual([
      "html",
      "ipynb",
    ]);
  });

  Vitest.it("preserves the order of existing formats", () => {
    Vitest.expect(
      mergeAutoDownloadFormats(["markdown", "html"], ["html", "markdown"]),
    ).toEqual(["markdown", "html"]);
  });
});

it.effect(
  "applies and saves selected automatic export formats",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const editor = VsCodeTest.makeNotebookEditor("/test/report.py", {
      data: {
        metadata: MarimoNotebookDocument.createMetadata({
          appOptions: appOptions(["html"]),
        }),
        cells: [
          {
            kind: 2,
            value: "1 + 1",
            languageId: "python",
            metadata: MarimoNotebookCell.createMetadata({
              marimoRuntime: { stableId: "cell-1" },
            }),
          },
        ],
      },
    });
    yield* vscode.openNotebook(editor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(editor));
    yield* vscode.selectQuickPickMany(["IPYNB"]);
    yield* configureAutoExport(notebookFor(editor));

    const snapshot = yield* vscode.snapshot;
    Vitest.expect(snapshot.workspaceEdits).toHaveLength(1);
    Vitest.expect(snapshot.informationMessages).toEqual([
      "Automatic exports enabled for IPYNB.",
    ]);
  }),
);

it.effect(
  "does not save when the selected formats are unchanged",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const editor = VsCodeTest.makeNotebookEditor("/test/report.py", {
      data: {
        cells: [],
        metadata: MarimoNotebookDocument.createMetadata({
          appOptions: appOptions(["markdown", "html"]),
        }),
      },
    });
    yield* vscode.openNotebook(editor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(editor));
    yield* vscode.selectQuickPickMany(["HTML", "Markdown"]);
    yield* configureAutoExport(notebookFor(editor));

    Vitest.expect((yield* vscode.snapshot).workspaceEdits).toEqual([]);
  }),
);

it.effect(
  "reports when all automatic exports are disabled",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const editor = VsCodeTest.makeNotebookEditor("/test/report.py", {
      data: {
        cells: [],
        metadata: MarimoNotebookDocument.createMetadata({
          appOptions: appOptions(["html", "ipynb", "markdown"]),
        }),
      },
    });
    yield* vscode.openNotebook(editor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(editor));
    yield* vscode.selectQuickPickMany([]);
    yield* configureAutoExport(notebookFor(editor));

    Vitest.expect((yield* vscode.snapshot).informationMessages).toEqual([
      "Automatic exports disabled.",
    ]);
  }),
);

Vitest.it.effect(
  "merges the selection into metadata changed while the picker is open",
  Effect.fn(function* () {
    const editor = VsCodeTest.makeNotebookEditor("/test/report.py", {
      data: {
        cells: [],
        metadata: MarimoNotebookDocument.createMetadata({
          appOptions: appOptions(["html"]),
        }),
      },
    });
    const layer = VsCodeTest.layerWith(
      {
        initialDocuments: [editor.notebook],
      },
      {
        window: {
          showQuickPickItemsMany: (items) =>
            Effect.sync(() => {
              const marimo = editor.notebook.metadata.marimo;
              if (!isRecord(marimo)) {
                throw new Error("Expected marimo notebook metadata");
              }
              const currentAppOptions = marimo.appOptions;
              if (!isRecord(currentAppOptions)) {
                throw new Error("Expected marimo app options");
              }
              marimo.appOptions = {
                ...currentAppOptions,
                passthrough: { width: "full" },
              };
              return Option.some(
                items.filter((item) => item.label === "IPYNB"),
              );
            }),
        },
      },
    );

    const snapshot = yield* Effect.gen(function* () {
      const vscode = yield* VsCodeTest.Service;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* configureAutoExport(notebookFor(editor));
      return yield* vscode.snapshot;
    }).pipe(Effect.provide(layer));

    const edit = Option.getOrThrow(
      Option.fromNullishOr(snapshot.workspaceEdits[0]),
    );
    const notebookEdits = VsCodeTest.getNotebookEdits(
      edit,
      editor.notebook.uri,
    );
    const metadata = Option.getOrThrow(
      Option.fromNullishOr(notebookEdits[0]?.newNotebookMetadata),
    );
    const updated = VsCodeTest.makeNotebookEditor("/test/report.py", {
      data: { cells: [], metadata },
    });
    const parsed = yield* MarimoNotebookDocument.from(
      updated.notebook,
    ).parseMetadata();
    Vitest.expect(parsed.appOptions).toMatchInlineSnapshot(`
      {
        "managed": {
          "autoDownload": [
            "ipynb",
          ],
        },
        "passthrough": {
          "width": "full",
        },
      }
    `);
  }),
);

it.effect(
  "reports an error instead of success when the notebook cannot be saved",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const editor = VsCodeTest.makeNotebookEditor("/test/report.py", {
      data: {
        cells: [],
        metadata: MarimoNotebookDocument.createMetadata({
          appOptions: appOptions(["html"]),
        }),
      },
    });
    Object.defineProperty(editor.notebook, "save", {
      value: () => Promise.resolve(false),
    });
    yield* vscode.openNotebook(editor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(editor));
    yield* vscode.selectQuickPickMany(["IPYNB"]);
    yield* configureAutoExport(notebookFor(editor));

    const snapshot = yield* vscode.snapshot;
    Vitest.expect(snapshot.informationMessages).toEqual([]);
    Vitest.expect(snapshot.errorMessages).toEqual([
      "Export formats changed but the notebook could not be saved.",
    ]);
  }),
);

it.effect(
  "reports an error instead of failing when saving rejects",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const editor = VsCodeTest.makeNotebookEditor("/test/report.py", {
      data: {
        cells: [],
        metadata: MarimoNotebookDocument.createMetadata({
          appOptions: appOptions(["html"]),
        }),
      },
    });
    Object.defineProperty(editor.notebook, "save", {
      value: () => Promise.reject(new Error("disk full")),
    });
    yield* vscode.openNotebook(editor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(editor));
    yield* vscode.selectQuickPickMany(["IPYNB"]);
    yield* configureAutoExport(notebookFor(editor));

    const snapshot = yield* vscode.snapshot;
    Vitest.expect(snapshot.informationMessages).toEqual([]);
    Vitest.expect(snapshot.errorMessages).toEqual([
      "Export formats changed but the notebook could not be saved.",
    ]);
  }),
);
