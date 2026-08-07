import { Schema } from "effect";

import { type CommandInvocation, marimoCommand } from "../commands.ts";
import { NotebookIdFromString } from "../schemas/MarimoNotebookDocument.ts";
import { CommandIds } from "./CommandIds.gen.ts";
import { Invocation } from "./Invocation.ts";

export const SessionCommandTarget = Schema.Struct({
  notebookUri: NotebookIdFromString,
});

export type SessionCommandTarget = typeof SessionCommandTarget.Type;

export const CellMetadataBindingId = Schema.String;
export type CellMetadataBindingId = typeof CellMetadataBindingId.Type;

const command = <
  CallArgs extends ReadonlyArray<unknown>,
  HandlerArgs extends ReadonlyArray<unknown>,
  Requirements,
>(
  id: string,
  invocation: CommandInvocation<CallArgs, HandlerArgs, Requirements>,
) => marimoCommand(id, invocation, Schema.Void);

export const MarimoCommands = {
  createSetupCell: command(
    CommandIds.createSetupCell,
    Invocation.CommandPalette.notebook,
  ),
  debugCell: command(
    CommandIds.debugCell,
    Invocation.CommandPalette.notebookCell,
  ),
  exportStaticHTML: command(
    CommandIds.exportStaticHTML,
    Invocation.CommandPalette.notebook,
  ),
  hideCellCode: command(
    CommandIds.hideCellCode,
    Invocation.join(
      Invocation.CommandPalette.notebookCell,
      Invocation.NotebookCellTitle.notebookCell,
    ),
  ),
  newMarimoNotebook: command(
    CommandIds.newMarimoNotebook,
    Invocation.join(Invocation.CommandPalette.none, Invocation.FileNew.none),
  ),
  openAsMarimoNotebook: command(
    CommandIds.openAsMarimoNotebook,
    Invocation.join(
      Invocation.CommandPalette.resource,
      Invocation.EditorTitle.resource,
      Invocation.CodeLens.resource,
    ),
  ),
  openOutlineView: command(
    CommandIds.openOutlineView,
    Invocation.join(
      Invocation.CommandPalette.none,
      Invocation.NotebookToolbar.none,
      Invocation.EditorTitle.none,
    ),
  ),
  openSession: command(
    CommandIds.openSession,
    Invocation.TreeItem.argument(SessionCommandTarget),
  ),
  openTutorial: command(
    CommandIds.openTutorial,
    Invocation.CommandPalette.none,
  ),
  publishMarimoNotebook: command(
    CommandIds.publishMarimoNotebook,
    Invocation.CommandPalette.notebook,
  ),
  refreshPackages: command(
    CommandIds.refreshPackages,
    Invocation.ViewTitle.none,
  ),
  reportIssue: command(CommandIds.reportIssue, Invocation.CommandPalette.none),
  restartKernel: command(
    CommandIds.restartKernel,
    Invocation.join(
      Invocation.CommandPalette.notebook,
      Invocation.NotebookToolbar.notebook,
    ),
  ),
  restartLsp: command(CommandIds.restartLsp, Invocation.CommandPalette.none),
  restartSession: command(
    CommandIds.restartSession,
    Invocation.ViewItemContext.argument(SessionCommandTarget),
  ),
  runStale: command(
    CommandIds.runStale,
    Invocation.join(
      Invocation.CommandPalette.notebook,
      Invocation.NotebookToolbar.notebook,
      Invocation.NotebookCellStatusBar.notebook,
    ),
  ),
  showCellCode: command(
    CommandIds.showCellCode,
    Invocation.join(
      Invocation.CommandPalette.notebookCell,
      Invocation.NotebookCellTitle.notebookCell,
    ),
  ),
  showDiagnostics: command(
    CommandIds.showDiagnostics,
    Invocation.CommandPalette.none,
  ),
  showMarimoMenu: command(CommandIds.showMarimoMenu, Invocation.StatusBar.none),
  showNotebookMenu: command(
    CommandIds.showNotebookMenu,
    Invocation.join(
      Invocation.CommandPalette.notebook,
      Invocation.NotebookToolbar.notebook,
    ),
  ),
  shutdownAllSessions: command(
    CommandIds.shutdownAllSessions,
    Invocation.ViewTitle.none,
  ),
  shutdownSession: command(
    CommandIds.shutdownSession,
    Invocation.ViewItemContext.argument(SessionCommandTarget),
  ),
  disableCell: command(
    CommandIds.disableCell,
    Invocation.NotebookCellTitle.notebookCell,
  ),
  enableCell: command(
    CommandIds.enableCell,
    Invocation.NotebookCellStatusBar.notebookCell,
  ),
  updateActivePythonEnvironment: command(
    CommandIds.updateActivePythonEnvironment,
    Invocation.CommandPalette.notebook,
  ),
  updateCellMetadata: command(
    CommandIds.updateCellMetadata,
    Invocation.withArguments(
      Invocation.NotebookCellStatusBar.notebookCell,
      Schema.Tuple(CellMetadataBindingId),
      1,
    ),
  ),
} as const satisfies Record<keyof typeof CommandIds, unknown>;
