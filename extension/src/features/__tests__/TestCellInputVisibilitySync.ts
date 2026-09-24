import {
  Context,
  Data,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Stream,
} from "effect";
import type * as vscode from "vscode";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import * as CellInputVisibilitySync from "../CellInputVisibilitySync.ts";

export interface CellState {
  readonly stableId: string;
  readonly hideCode: boolean;
  readonly kind?: 1 | 2;
}

export const states = (hideCode: ReadonlyArray<boolean>): CellState[] =>
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

export const makeEditor = (
  cells: ReadonlyArray<CellState>,
  uri = "/test/notebook_mo.py",
) =>
  TestVsCode.makeNotebookEditor(uri, {
    data: { cells: cells.map(cellData) },
  });

const isCellRange = (value: unknown): value is CellInputVisibilitySync.Range =>
  typeof value === "object" &&
  value !== null &&
  "start" in value &&
  typeof value.start === "number" &&
  "end" in value &&
  typeof value.end === "number";

const commandRanges = (
  executions: ReadonlyArray<TestVsCode.CommandExecution>,
  command: "notebook.cell.collapseCellInput" | "notebook.cell.expandCellInput",
  document: vscode.NotebookDocument,
) =>
  executions
    .filter((execution) => execution.command === command)
    .filter((execution) => {
      const options = execution.args[0];
      return (
        typeof options === "object" &&
        options !== null &&
        "document" in options &&
        String(options.document) === document.uri.toString()
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

export type Scenario = Data.TaggedEnum<{
  Normal: {};
  DefectFirstCommand: {};
}>;
export const Scenario = Data.taggedEnum<Scenario>();

export interface Interface {
  readonly attempts: Effect.Effect<number>;
  readonly activate: (editor: vscode.NotebookEditor) => Effect.Effect<void>;
  readonly deactivate: Effect.Effect<void>;
  readonly close: (document: vscode.NotebookDocument) => Effect.Effect<void>;
  readonly change: (
    editor: vscode.NotebookEditor,
    cells: ReadonlyArray<CellState>,
  ) => Effect.Effect<void>;
  readonly collapsed: (
    editor: vscode.NotebookEditor,
  ) => Effect.Effect<
    ReadonlyArray<ReadonlyArray<CellInputVisibilitySync.Range>>
  >;
  readonly expanded: (
    editor: vscode.NotebookEditor,
  ) => Effect.Effect<
    ReadonlyArray<ReadonlyArray<CellInputVisibilitySync.Range>>
  >;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/CellInputVisibilitySync",
) {}

export const layerWith = (scenario: Scenario) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const vscodeLayer = TestVsCode.layerWith(
        Scenario.$is("DefectFirstCommand")(scenario)
          ? {
              commands: {
                executeVSCode: () =>
                  Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                    Effect.flatMap((count) =>
                      count === 1
                        ? Effect.die(new Error("VS Code command rejected"))
                        : Effect.void,
                    ),
                  ),
              },
            }
          : {},
      );
      const environment = CellInputVisibilitySync.layer.pipe(
        Layer.provideMerge(vscodeLayer),
      );
      const model = Layer.effect(
        Service,
        Effect.gen(function* () {
          const vscode = yield* TestVsCode.Service;
          const sync = yield* CellInputVisibilitySync.Service;

          const process = (action: Effect.Effect<unknown>) =>
            Effect.gen(function* () {
              const expected = (yield* sync.processedRevision) + 1;
              const processed = yield* sync.processedChanges.pipe(
                Stream.filter((revision) => revision >= expected),
                Stream.runHead,
                Effect.forkChild({ startImmediately: true }),
              );
              yield* action;
              yield* Fiber.join(processed);
            });

          const change: Interface["change"] = (editor, cells) =>
            Effect.gen(function* () {
              const removedCells = Array.from(editor.notebook.getCells());
              TestVsCode.replaceTestNotebookCells(
                editor.notebook,
                cells.map(cellData),
              );
              yield* process(
                vscode.notebookChange({
                  notebook: editor.notebook,
                  metadata: undefined,
                  cellChanges: [],
                  contentChanges: [
                    {
                      range: new TestVsCode.NotebookRange(
                        0,
                        removedCells.length,
                      ),
                      removedCells,
                      addedCells: Array.from(editor.notebook.getCells()),
                    },
                  ],
                }),
              );
            });

          const ranges = (
            editor: vscode.NotebookEditor,
            command:
              | "notebook.cell.collapseCellInput"
              | "notebook.cell.expandCellInput",
          ) =>
            Effect.map(vscode.snapshot, ({ executions }) =>
              commandRanges(executions, command, editor.notebook),
            );

          return Service.of({
            attempts: Ref.get(attempts),
            activate: (editor) =>
              vscode
                .openNotebook(editor.notebook)
                .pipe(
                  Effect.andThen(
                    process(
                      vscode.setActiveNotebookEditor(Option.some(editor)),
                    ),
                  ),
                ),
            deactivate: vscode.setActiveNotebookEditor(Option.none()),
            close: (document) => process(vscode.closeNotebook(document)),
            change,
            collapsed: (editor) =>
              ranges(editor, "notebook.cell.collapseCellInput"),
            expanded: (editor) =>
              ranges(editor, "notebook.cell.expandCellInput"),
          });
        }),
      ).pipe(Layer.provide(environment));

      return Layer.merge(environment, model);
    }),
  );

export const layer = layerWith(Scenario.Normal());
