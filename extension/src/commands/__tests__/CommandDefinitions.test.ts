import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  createNotebookCell,
  createTestNotebookDocument,
} from "../../__mocks__/TestVsCode.ts";
import { commandId, decodeCommandArguments } from "../../commands.ts";
import { createSetupCellCommand } from "../createSetupCell.ts";
import { debugCellCommand } from "../debugCell.ts";
import { exportNotebookAsHtmlCommand } from "../exportNotebookAsHtml.ts";
import { GeneratedMarimoCommands } from "../MarimoCommands.gen.ts";
import { newMarimoNotebookCommand } from "../newMarimoNotebook.ts";
import { openAsMarimoNotebookCommand } from "../openAsMarimoNotebook.ts";
import { openOutlineViewCommand } from "../openOutlineView.ts";
import { openTutorialCommand } from "../openTutorial.ts";
import { publishMarimoNotebookCommand } from "../publishMarimoNotebook.ts";
import { refreshPackagesCommand } from "../refreshPackages.ts";
import { reportIssueCommand } from "../reportIssue.ts";
import { restartKernelCommand } from "../restartKernel.ts";
import { restartLspCommand } from "../restartLsp.ts";
import { runStaleCommand } from "../runStale.ts";
import {
  openSessionCommand,
  restartSessionCommand,
  shutdownAllSessionsCommand,
  shutdownSessionCommand,
} from "../sessionCommands.ts";
import {
  hideCellCodeCommand,
  showCellCodeCommand,
} from "../setCellCodeVisibility.ts";
import { showDiagnosticsCommand } from "../showDiagnostics.ts";
import { showMarimoMenuCommand } from "../showMarimoMenu.ts";
import { showNotebookMenuCommand } from "../showNotebookMenu.ts";
import { updateActivePythonEnvironmentCommand } from "../updateActivePythonEnvironment.ts";
import { updateCellMetadataCommand } from "../updateCellMetadata.ts";

const definitions = [
  createSetupCellCommand,
  debugCellCommand,
  exportNotebookAsHtmlCommand,
  hideCellCodeCommand,
  newMarimoNotebookCommand,
  openAsMarimoNotebookCommand,
  openOutlineViewCommand,
  openSessionCommand,
  openTutorialCommand,
  publishMarimoNotebookCommand,
  refreshPackagesCommand,
  reportIssueCommand,
  restartKernelCommand,
  restartLspCommand,
  restartSessionCommand,
  runStaleCommand,
  showCellCodeCommand,
  showDiagnosticsCommand,
  showMarimoMenuCommand,
  showNotebookMenuCommand,
  shutdownAllSessionsCommand,
  shutdownSessionCommand,
  updateActivePythonEnvironmentCommand,
  updateCellMetadataCommand,
] as const;

describe("command definitions", () => {
  it("covers every generated command exactly once", () => {
    expect(definitions.map(commandId).toSorted()).toEqual(
      Object.values(GeneratedMarimoCommands).map(commandId).toSorted(),
    );
  });

  it.effect("ignores VS Code context for a context-free command", () =>
    Effect.gen(function* () {
      const args = yield* decodeCommandArguments(restartLspCommand, [
        {
          ui: true,
          notebookEditor: { notebookUri: "file:///notebook.py" },
          source: "notebookToolbar",
        },
      ]);
      expect(args).toEqual([]);
    }),
  );

  it.effect("accepts an empty argument list for a no-argument command", () =>
    Effect.gen(function* () {
      const args = yield* decodeCommandArguments(restartLspCommand, []);
      expect(args).toEqual([]);
    }),
  );

  it.effect("accepts notebook cell context for a notebook command", () =>
    Effect.gen(function* () {
      const notebook = createTestNotebookDocument("/test/notebook_mo.py");
      const cell = createNotebookCell(
        notebook,
        { kind: 2, value: "x = 1", languageId: "python" },
        5,
      );

      const args = yield* decodeCommandArguments(runStaleCommand, [cell]);

      expect(args).toEqual([cell]);
    }),
  );

  it.effect("preserves notebook context for interpreter synchronization", () =>
    Effect.gen(function* () {
      const notebookUri = {
        scheme: "file",
        path: "/notebook.py",
        with() {
          return this;
        },
        toString() {
          return "file:///notebook.py";
        },
      };
      const args = yield* decodeCommandArguments(
        updateActivePythonEnvironmentCommand,
        [{ notebookEditor: { notebookUri } }],
      );
      expect(args).toEqual([{ notebookEditor: { notebookUri } }]);
    }),
  );

  it.effect("decodes the target cell supplied by a notebook cell menu", () =>
    Effect.gen(function* () {
      const cell = createNotebookCell(
        createTestNotebookDocument("/test/notebook_mo.py"),
        { kind: 2, value: "x = 1", languageId: "python" },
        0,
      );

      const args = yield* decodeCommandArguments(hideCellCodeCommand, [cell]);

      expect(args).toEqual([cell]);
    }),
  );

  it.effect("decodes the first external argument for open-as-notebook", () =>
    Effect.gen(function* () {
      const args = yield* decodeCommandArguments(openAsMarimoNotebookCommand, [
        "file:///notebook.py",
        { external: "context" },
      ]);
      expect(args).toEqual(["file:///notebook.py"]);
    }),
  );

  it.effect("ignores contextual arguments for view-title commands", () =>
    Effect.gen(function* () {
      const context = { injectedBy: "view/title" };
      expect(
        yield* decodeCommandArguments(shutdownAllSessionsCommand, [context]),
      ).toEqual([]);
      expect(
        yield* decodeCommandArguments(refreshPackagesCommand, [context]),
      ).toEqual([]);
    }),
  );
});
