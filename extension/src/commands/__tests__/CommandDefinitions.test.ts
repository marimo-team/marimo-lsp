import { describe, expect, it } from "@effect/vitest";
import { Effect, Logger, Option, Ref, References } from "effect";

import { createNotebookCell, TestVsCode } from "../../__mocks__/TestVsCode.ts";
import {
  commandContributedSurfaces,
  defineCommand,
  commandId,
  decodeCommandArguments,
} from "../../commands.ts";
import { CommandIds, CommandSurfaces } from "../CommandIds.gen.ts";
import hideCellCode from "../hideCellCode.ts";
import { MarimoCommands } from "../MarimoCommands.ts";

describe("command definitions", () => {
  it("defines every generated command exactly once", () => {
    expect(Object.values(MarimoCommands).map(commandId).toSorted()).toEqual(
      Object.values(CommandIds).toSorted(),
    );
  });

  it("matches every generated contributed surface", () => {
    const actual = Object.fromEntries(
      Object.entries(MarimoCommands).map(([name, command]) => [
        name,
        commandContributedSurfaces(command).toSorted(),
      ]),
    );
    expect(actual).toEqual(CommandSurfaces);
  });

  it.effect(
    "ignores VS Code metadata for a no-target command",
    Effect.fn(function* () {
      const args = yield* decodeCommandArguments(MarimoCommands.restartLsp, [
        { injectedBy: "commandPalette" },
      ]);
      expect(args).toEqual([]);
    }),
  );

  it.effect(
    "normalizes a cell-status invocation to its exact notebook",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
      const vscode = yield* TestVsCode.make({
        initialDocuments: [editor.notebook],
      });
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      const cell = createNotebookCell(
        editor.notebook,
        { kind: 2, value: "x = 1", languageId: "python" },
        0,
      );

      const [target] = yield* decodeCommandArguments(MarimoCommands.runStale, [
        cell,
      ]).pipe(Effect.provide(vscode.layer));

      expect(Option.getOrThrow(target).editor).toBe(editor);
      expect(Option.getOrThrow(target).document.uri.toString()).toBe(
        editor.notebook.uri.toString(),
      );
    }),
  );

  it.effect(
    "normalizes a cell-title invocation to a marimo cell",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
      const vscode = yield* TestVsCode.make();
      const cell = createNotebookCell(
        editor.notebook,
        { kind: 2, value: "x = 1", languageId: "python" },
        0,
      );

      const [target] = yield* decodeCommandArguments(
        MarimoCommands.hideCellCode,
        [cell],
      ).pipe(Effect.provide(vscode.layer));

      expect(Option.getOrThrow(target).index).toBe(0);
    }),
  );

  it.effect(
    "handles a cell-container invocation using the active cell",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
        data: {
          cells: [{ kind: 2, value: "x = 1", languageId: "python" }],
        },
      });
      const vscode = yield* TestVsCode.make({
        initialDocuments: [editor.notebook],
      });
      yield* vscode.setActiveNotebookEditor(Option.some(editor));

      const [target] = yield* decodeCommandArguments(
        MarimoCommands.hideCellCode,
        [{ from: "cellContainer" }],
      ).pipe(Effect.provide(vscode.layer));

      expect(Option.getOrThrow(target).index).toBe(0);
      yield* hideCellCode.invoke(target).pipe(Effect.provide(vscode.layer));
      expect(yield* Ref.get(vscode.executions)).toContainEqual({
        command: "notebook.cell.collapseCellInput",
        args: [
          {
            ranges: [{ start: 0, end: 1 }],
            document: editor.notebook.uri,
          },
        ],
      });
    }),
  );

  it.effect(
    "ignores a cell-container invocation without an active cell",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make();

      const [target] = yield* decodeCommandArguments(
        MarimoCommands.hideCellCode,
        [{ from: "cellContainer" }],
      ).pipe(Effect.provide(vscode.layer));

      expect(Option.isNone(target)).toBe(true);
      yield* hideCellCode.invoke(target).pipe(Effect.provide(vscode.layer));
      expect(yield* Ref.get(vscode.executions)).toEqual([]);
    }),
  );

  it.effect.each([MarimoCommands.hideCellCode, MarimoCommands.showCellCode])(
    "resolves an omitted cell target to the active cell",
    Effect.fn(function* (command) {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
        data: {
          cells: [{ kind: 2, value: "x = 1", languageId: "python" }],
        },
      });
      const vscode = yield* TestVsCode.make({
        initialDocuments: [editor.notebook],
      });
      yield* vscode.setActiveNotebookEditor(Option.some(editor));

      const [target] = yield* decodeCommandArguments(command, []).pipe(
        Effect.provide(vscode.layer),
      );

      expect(Option.getOrThrow(target).index).toBe(0);
    }),
  );

  it.effect(
    "preserves a resource argument after joining surfaces",
    Effect.fn(function* () {
      const args = yield* decodeCommandArguments(
        MarimoCommands.openAsMarimoNotebook,
        ["file:///notebook.py"],
      );
      expect(args).toEqual(["file:///notebook.py"]);
    }),
  );

  it.effect("traces direct normalized invocation with the command ID", () => {
    const logs: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ fiber }) => {
      const span = fiber.currentSpan;
      logs.push({
        ...fiber.getRef(References.CurrentLogAnnotations),
        ...(span !== undefined && span._tag === "Span"
          ? { "effect.spanName": span.name }
          : {}),
      });
    });
    const definition = defineCommand(MarimoCommands.restartLsp, () =>
      Effect.logInfo("invoked"),
    );

    return definition.invoke().pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(logs).toHaveLength(1);
          expect(logs[0]).toMatchObject({
            "command.id": commandId(definition.command),
            "effect.spanName": "command",
          });
        }),
      ),
    );
  });
});
