import * as Vitest from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Option, Ref, Stream } from "effect";
import type * as vscode from "vscode";

import * as CellInputVisibilitySync from "../../src/features/CellInputVisibilitySync.ts";
import { MarimoNotebookCell } from "../../src/schemas/MarimoNotebookDocument.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

interface CellState {
  readonly stableId: string;
  readonly hideCode: boolean;
  readonly kind?: 1 | 2;
}

const states = (hideCode: ReadonlyArray<boolean>): CellState[] =>
  hideCode.map((hidden, index) => ({
    stableId: `cell-${index}`,
    hideCode: hidden,
  }));

const cellData = ({ stableId, hideCode: hide_code, kind = 2 }: CellState) => ({
  kind,
  value: "",
  languageId: kind === 1 ? "markdown" : "python",
  metadata: MarimoNotebookCell.createMetadata({
    marimo: { options: { hide_code } },
    marimoRuntime: { stableId },
  }),
});

const makeEditor = (
  cells: ReadonlyArray<CellState>,
  uri = "/test/notebook_mo.py",
) =>
  VsCodeTest.makeNotebookEditor(uri, {
    data: { cells: cells.map(cellData) },
  });

const cell = (index: number, hideCode: boolean, kind: 1 | 2 = 2) =>
  MarimoNotebookCell.from(
    VsCodeTest.createNotebookCell(
      VsCodeTest.createTestNotebookDocument("/test/notebook_mo.py"),
      cellData({ stableId: `cell-${index}`, hideCode, kind }),
      index,
    ),
  );

const isCellRange = (value: unknown): value is CellInputVisibilitySync.Range =>
  typeof value === "object" &&
  value !== null &&
  "start" in value &&
  typeof value.start === "number" &&
  "end" in value &&
  typeof value.end === "number";

type VisibilityCommand =
  | "notebook.cell.collapseCellInput"
  | "notebook.cell.expandCellInput";

/** Ranges passed to `command` for `document`, one entry per invocation. */
const ranges = Effect.fn("ranges")(function* (
  editor: vscode.NotebookEditor,
  command: VisibilityCommand,
) {
  const vscode = yield* VsCodeTest.Service;
  const { executions } = yield* vscode.snapshot;
  return executions
    .filter((execution) => execution.command === command)
    .filter((execution) => {
      const options = execution.args[0];
      return (
        typeof options === "object" &&
        options !== null &&
        "document" in options &&
        String(options.document) === editor.notebook.uri.toString()
      );
    })
    .flatMap((execution) => {
      const options = execution.args[0];
      if (
        typeof options !== "object" ||
        options === null ||
        !("ranges" in options) ||
        !Array.isArray(options.ranges) ||
        !options.ranges.every(isCellRange)
      ) {
        return [];
      }
      return [options.ranges];
    });
});

const collapsed = (editor: vscode.NotebookEditor) =>
  ranges(editor, "notebook.cell.collapseCellInput");
const expanded = (editor: vscode.NotebookEditor) =>
  ranges(editor, "notebook.cell.expandCellInput");

/** Runs `action` and waits until the sync has processed the matching event. */
const process = Effect.fn("process")(function* (
  action: Effect.Effect<unknown>,
  matches: (event: CellInputVisibilitySync.Processed) => boolean,
) {
  const sync = yield* CellInputVisibilitySync.Service;
  const changes = yield* sync.subscribeProcessed;
  const processed = yield* changes.pipe(
    Stream.filter(matches),
    Stream.runHead,
    Effect.forkChild,
  );
  yield* action;
  yield* Effect.flatMap(
    Fiber.join(processed),
    Option.match({
      onNone: () => Effect.die("The sync stopped before processing the event"),
      onSome: () => Effect.void,
    }),
  );
}, Effect.scoped);

const activate = Effect.fn("activate")(function* (
  editor: vscode.NotebookEditor,
) {
  const vscode = yield* VsCodeTest.Service;
  yield* vscode.openNotebook(editor.notebook);
  yield* process(
    vscode.setActiveNotebookEditor(Option.some(editor)),
    (processed) =>
      processed._tag === "Activated" && processed.editor === editor,
  );
});

const deactivate = Effect.gen(function* () {
  const vscode = yield* VsCodeTest.Service;
  yield* vscode.setActiveNotebookEditor(Option.none());
});

const close = Effect.fn("close")(function* (document: vscode.NotebookDocument) {
  const vscode = yield* VsCodeTest.Service;
  yield* process(
    vscode.closeNotebook(document),
    (processed) =>
      processed._tag === "Closed" && processed.document === document,
  );
});

/** Replaces every cell in the notebook and waits for the change to sync. */
const change = Effect.fn("change")(function* (
  editor: vscode.NotebookEditor,
  cells: ReadonlyArray<CellState>,
) {
  const vscode = yield* VsCodeTest.Service;
  const removedCells = Array.from(editor.notebook.getCells());
  VsCodeTest.replaceTestNotebookCells(editor.notebook, cells.map(cellData));
  const event: vscode.NotebookDocumentChangeEvent = {
    notebook: editor.notebook,
    metadata: undefined,
    cellChanges: [],
    contentChanges: [
      {
        range: new VsCodeTest.NotebookRange(0, removedCells.length),
        removedCells,
        addedCells: Array.from(editor.notebook.getCells()),
      },
    ],
  };
  yield* process(
    vscode.notebookChange(event),
    (processed) => processed._tag === "Changed" && processed.event === event,
  );
});

Vitest.describe("visibility completion observations", () => {
  const it = EffectTest.make(
    CellInputVisibilitySync.layer.pipe(Layer.provideMerge(VsCodeTest.layer)),
  );

  it.effect(
    "buffers the exact processed changes even when no command is needed",
    () =>
      Effect.gen(function* () {
        const sync = yield* CellInputVisibilitySync.Service;
        const vscode = yield* VsCodeTest.Service;
        const processed = yield* sync.subscribeProcessed;
        const changes = ["first.py", "second.py"].map((name) => ({
          notebook: VsCodeTest.makeNotebookEditor(`/test/${name}`).notebook,
          metadata: undefined,
          cellChanges: [],
          contentChanges: [],
        }));

        // Subscription acquisition must precede publishing; consumption can wait.
        for (const change of changes) yield* vscode.notebookChange(change);
        const observed = yield* processed.pipe(
          Stream.take(2),
          Stream.runCollect,
        );
        Vitest.expect(observed).toEqual(
          changes.map((event) => ({ _tag: "Changed", event })),
        );
        Vitest.expect((yield* vscode.snapshot).executions).toEqual([]);
      }),
  );
});

Vitest.describe("hiddenInputRanges", () => {
  Vitest.it(
    "returns one end-exclusive range per hide_code cell, by index",
    () => {
      const cells = [
        cell(0, false),
        cell(1, true),
        cell(2, false),
        cell(3, true),
      ];
      Vitest.expect(CellInputVisibilitySync.hiddenInputRanges(cells)).toEqual([
        { start: 1, end: 2 },
        { start: 3, end: 4 },
      ]);
    },
  );

  Vitest.it("returns no ranges when no cell hides its code", () => {
    Vitest.expect(
      CellInputVisibilitySync.hiddenInputRanges([cell(0, false)]),
    ).toEqual([]);
  });

  Vitest.it(
    "does not hide native markup cells with persisted hide_code",
    () => {
      Vitest.expect(
        CellInputVisibilitySync.hiddenInputRanges([cell(0, true, 1)]),
      ).toEqual([]);
    },
  );
});

Vitest.describe("CellInputVisibilitySync", () => {
  const it = EffectTest.make(
    CellInputVisibilitySync.layer.pipe(Layer.provideMerge(VsCodeTest.layer)),
  );

  it.effect(
    "collapses hide_code cells when a notebook first becomes active",
    Effect.fn(function* () {
      const editor = makeEditor(states([false, true, true]));
      yield* activate(editor);
      Vitest.expect(yield* collapsed(editor)).toEqual([
        [
          { start: 1, end: 2 },
          { start: 2, end: 3 },
        ],
      ]);
    }),
  );

  it.effect(
    "expands markup cells while collapsing hidden code cells on activation",
    Effect.fn(function* () {
      const editor = makeEditor([
        { stableId: "code", hideCode: true },
        { stableId: "markdown", hideCode: true, kind: 1 },
      ]);
      yield* activate(editor);
      Vitest.expect(yield* collapsed(editor)).toEqual([[{ start: 0, end: 1 }]]);
      Vitest.expect(yield* expanded(editor)).toEqual([[{ start: 1, end: 2 }]]);
    }),
  );

  it.effect(
    "re-expands markup cells whenever the notebook becomes active",
    Effect.fn(function* () {
      const editor = makeEditor([
        { stableId: "markdown", hideCode: true, kind: 1 },
      ]);
      yield* activate(editor);
      yield* deactivate;
      yield* activate(editor);
      Vitest.expect(yield* expanded(editor)).toEqual([
        [{ start: 0, end: 1 }],
        [{ start: 0, end: 1 }],
      ]);
    }),
  );

  it.effect(
    "collapses once and does not re-collapse on tab refocus",
    Effect.fn(function* () {
      const editor = makeEditor(states([true]));
      yield* activate(editor);
      yield* deactivate;
      yield* activate(editor);
      Vitest.expect(yield* collapsed(editor)).toEqual([[{ start: 0, end: 1 }]]);
    }),
  );

  it.effect(
    "collapses hidden cells again after the notebook is closed and reopened",
    Effect.fn(function* () {
      const editor = makeEditor(states([true]));
      const reopened = makeEditor(states([true]));
      yield* activate(editor);
      yield* deactivate;
      yield* close(editor.notebook);
      yield* activate(reopened);
      Vitest.expect(yield* collapsed(editor)).toEqual([
        [{ start: 0, end: 1 }],
        [{ start: 0, end: 1 }],
      ]);
    }),
  );

  it.effect(
    "collapses a cell when hide_code changes to true",
    Effect.fn(function* () {
      const editor = makeEditor(states([false]));
      yield* activate(editor);
      yield* change(editor, states([true]));
      Vitest.expect(yield* collapsed(editor)).toEqual([[{ start: 0, end: 1 }]]);
    }),
  );

  it.effect(
    "expands a cell when hide_code changes to false",
    Effect.fn(function* () {
      const editor = makeEditor(states([true]));
      yield* activate(editor);
      yield* change(editor, states([false]));
      Vitest.expect(yield* expanded(editor)).toEqual([[{ start: 0, end: 1 }]]);
    }),
  );

  it.effect(
    "tracks cells by stable ID across structural reordering",
    Effect.fn(function* () {
      const editor = makeEditor(states([false, true]));
      yield* activate(editor);
      yield* change(editor, [
        { stableId: "cell-1", hideCode: true },
        { stableId: "cell-0", hideCode: false },
      ]);
      Vitest.expect(yield* collapsed(editor)).toEqual([[{ start: 1, end: 2 }]]);
      Vitest.expect(yield* expanded(editor)).toEqual([]);
    }),
  );

  it.effect(
    "expands a hidden code cell when it becomes markup",
    Effect.fn(function* () {
      const editor = makeEditor([{ stableId: "cell", hideCode: true }]);
      yield* activate(editor);
      yield* change(editor, [{ stableId: "cell", hideCode: true, kind: 1 }]);
      Vitest.expect(yield* expanded(editor)).toEqual([[{ start: 0, end: 1 }]]);
    }),
  );

  Vitest.describe("when a visibility command defects", () => {
    /** Number of VS Code commands attempted; the first one defects. */
    class Attempts extends Context.Service<Attempts, Ref.Ref<number>>()(
      "@marimo/test/CellInputVisibilitySync/Attempts",
    ) {}

    const it = EffectTest.make(
      Layer.unwrap(
        Effect.map(Ref.make(0), (attempts) =>
          Layer.merge(
            CellInputVisibilitySync.layer.pipe(
              Layer.provideMerge(
                VsCodeTest.layerWith(
                  {},
                  {
                    commands: {
                      executeVSCode: () =>
                        Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                          Effect.flatMap((count) =>
                            count === 1
                              ? Effect.die(
                                  new Error("VS Code command rejected"),
                                )
                              : Effect.void,
                          ),
                        ),
                    },
                  },
                ),
              ),
            ),
            Layer.succeed(Attempts, attempts),
          ),
        ),
      ),
    );

    it.effect(
      "continues synchronizing",
      Effect.fn(function* () {
        const attempts = yield* Attempts;
        const editor = makeEditor(states([false]));
        yield* activate(editor);
        yield* change(editor, states([true]));
        yield* change(editor, states([true]));
        Vitest.expect(yield* Ref.get(attempts)).toBe(2);
      }),
    );
  });
});
