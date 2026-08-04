import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Ref } from "effect";

import { getNotebookEdits, TestVsCode } from "../../__mocks__/TestVsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../../schemas/MarimoNotebookDocument.ts";
import {
  configureAutoExport,
  mergeAutoDownloadFormats,
} from "../configureAutoExport.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("mergeAutoDownloadFormats", () => {
  it("updates all managed formats from the selection", () => {
    expect(mergeAutoDownloadFormats(["html", "markdown"], ["ipynb"])).toEqual([
      "ipynb",
    ]);
  });

  it("uses stable format ordering", () => {
    expect(mergeAutoDownloadFormats([], ["ipynb", "html"])).toEqual([
      "html",
      "ipynb",
    ]);
  });

  it("preserves the order of existing formats", () => {
    expect(
      mergeAutoDownloadFormats(["markdown", "html"], ["html", "markdown"]),
    ).toEqual(["markdown", "html"]);
  });
});

it.effect(
  "applies and saves selected automatic export formats",
  Effect.fn(function* () {
    const applied = yield* Ref.make(false);
    const information = yield* Ref.make(Option.none<string>());
    const editor = TestVsCode.makeNotebookEditor("/test/report.py", {
      data: {
        metadata: MarimoNotebookDocument.createMetadata({
          appConfig: { auto_download: ["html"] },
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
    const vscode = yield* TestVsCode.make({
      initialDocuments: [editor.notebook],
      window: {
        showQuickPickItemsMany: (items) =>
          Effect.succeed(
            Option.some(items.filter((item) => item.label === "IPYNB")),
          ),
        showInformationMessage: (message) =>
          Ref.set(information, Option.some(message)).pipe(
            Effect.as(Option.none()),
          ),
      },
      workspace: {
        applyEdit: () => Ref.set(applied, true).pipe(Effect.as(true)),
      },
    });

    yield* vscode.setActiveNotebookEditor(Option.some(editor));
    yield* configureAutoExport().pipe(Effect.provide(vscode.layer));

    expect(yield* applied).toBe(true);
    expect(yield* information).toEqual(
      Option.some("Automatic exports enabled for IPYNB."),
    );
  }),
);

it.effect(
  "does not save when the selected formats are unchanged",
  Effect.fn(function* () {
    const applied = yield* Ref.make(false);
    const editor = TestVsCode.makeNotebookEditor("/test/report.py", {
      data: {
        cells: [],
        metadata: MarimoNotebookDocument.createMetadata({
          appConfig: { auto_download: ["markdown", "html"] },
        }),
      },
    });
    const vscode = yield* TestVsCode.make({
      initialDocuments: [editor.notebook],
      window: {
        showQuickPickItemsMany: (items) =>
          Effect.succeed(
            Option.some(
              items.filter(
                (item) => item.label === "HTML" || item.label === "Markdown",
              ),
            ),
          ),
      },
      workspace: {
        applyEdit: () => Ref.set(applied, true).pipe(Effect.as(true)),
      },
    });

    yield* vscode.setActiveNotebookEditor(Option.some(editor));
    yield* configureAutoExport().pipe(Effect.provide(vscode.layer));

    expect(yield* applied).toBe(false);
  }),
);

it.effect(
  "merges the selection into metadata changed while the picker is open",
  Effect.fn(function* () {
    const updatedMetadata = yield* Ref.make(
      Option.none<Record<string, unknown>>(),
    );
    const editor = TestVsCode.makeNotebookEditor("/test/report.py", {
      data: {
        cells: [],
        metadata: MarimoNotebookDocument.createMetadata({
          appConfig: { auto_download: ["html"] },
        }),
      },
    });
    const vscode = yield* TestVsCode.make({
      initialDocuments: [editor.notebook],
      window: {
        showQuickPickItemsMany: (items) =>
          Effect.sync(() => {
            const marimo = editor.notebook.metadata.marimo;
            if (!isRecord(marimo)) {
              throw new Error("Expected marimo notebook metadata");
            }
            const appConfig = marimo.appConfig;
            if (!isRecord(appConfig)) {
              throw new Error("Expected marimo app config");
            }
            marimo.appConfig = {
              ...appConfig,
              width: "full",
            };
            return Option.some(items.filter((item) => item.label === "IPYNB"));
          }),
      },
      workspace: {
        applyEdit: (edit) => {
          const notebookEdits = getNotebookEdits(edit, editor.notebook.uri);
          return Ref.set(
            updatedMetadata,
            Option.fromNullable(notebookEdits[0]?.newNotebookMetadata),
          ).pipe(Effect.as(true));
        },
      },
    });

    yield* vscode.setActiveNotebookEditor(Option.some(editor));
    yield* configureAutoExport().pipe(Effect.provide(vscode.layer));

    const metadata = Option.getOrThrow(yield* updatedMetadata);
    const updated = TestVsCode.makeNotebookEditor("/test/report.py", {
      data: { cells: [], metadata },
    });
    const parsed = yield* MarimoNotebookDocument.from(
      updated.notebook,
    ).parseMetadata();
    expect(parsed.appConfig).toMatchObject({ width: "full" });
    expect(parsed.appConfig.auto_download).toEqual(["ipynb"]);
  }),
);

it.effect(
  "reports an error instead of success when the notebook cannot be saved",
  Effect.fn(function* () {
    const information = yield* Ref.make(Option.none<string>());
    const error = yield* Ref.make(Option.none<string>());
    const editor = TestVsCode.makeNotebookEditor("/test/report.py", {
      data: {
        cells: [],
        metadata: MarimoNotebookDocument.createMetadata({
          appConfig: { auto_download: ["html"] },
        }),
      },
    });
    Object.defineProperty(editor.notebook, "save", {
      value: () => Promise.resolve(false),
    });
    const vscode = yield* TestVsCode.make({
      initialDocuments: [editor.notebook],
      window: {
        showQuickPickItemsMany: (items) =>
          Effect.succeed(
            Option.some(items.filter((item) => item.label === "IPYNB")),
          ),
        showInformationMessage: (message) =>
          Ref.set(information, Option.some(message)).pipe(
            Effect.as(Option.none()),
          ),
        showErrorMessage: (message) =>
          Ref.set(error, Option.some(message)).pipe(Effect.as(Option.none())),
      },
      workspace: {
        applyEdit: () => Effect.succeed(true),
      },
    });

    yield* vscode.setActiveNotebookEditor(Option.some(editor));
    yield* configureAutoExport().pipe(Effect.provide(vscode.layer));

    expect(yield* information).toEqual(Option.none());
    expect(yield* error).toEqual(
      Option.some(
        "Export formats changed but the notebook could not be saved.",
      ),
    );
  }),
);

it.effect(
  "reports an error instead of failing when saving rejects",
  Effect.fn(function* () {
    const information = yield* Ref.make(Option.none<string>());
    const error = yield* Ref.make(Option.none<string>());
    const editor = TestVsCode.makeNotebookEditor("/test/report.py", {
      data: {
        cells: [],
        metadata: MarimoNotebookDocument.createMetadata({
          appConfig: { auto_download: ["html"] },
        }),
      },
    });
    Object.defineProperty(editor.notebook, "save", {
      value: () => Promise.reject(new Error("disk full")),
    });
    const vscode = yield* TestVsCode.make({
      initialDocuments: [editor.notebook],
      window: {
        showQuickPickItemsMany: (items) =>
          Effect.succeed(
            Option.some(items.filter((item) => item.label === "IPYNB")),
          ),
        showInformationMessage: (message) =>
          Ref.set(information, Option.some(message)).pipe(
            Effect.as(Option.none()),
          ),
        showErrorMessage: (message) =>
          Ref.set(error, Option.some(message)).pipe(Effect.as(Option.none())),
      },
      workspace: {
        applyEdit: () => Effect.succeed(true),
      },
    });

    yield* vscode.setActiveNotebookEditor(Option.some(editor));
    yield* configureAutoExport().pipe(Effect.provide(vscode.layer));

    expect(yield* information).toEqual(Option.none());
    expect(yield* error).toEqual(
      Option.some(
        "Export formats changed but the notebook could not be saved.",
      ),
    );
  }),
);
