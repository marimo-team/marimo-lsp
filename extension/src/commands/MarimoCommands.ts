import { Schema } from "effect";

import {
  withFirstArgument,
  withOptionalFirstArgument,
  VscodeUriSchema,
} from "../commands.ts";
import { NotebookIdFromString } from "../schemas/MarimoNotebookDocument.ts";
import { GeneratedMarimoCommands } from "./MarimoCommands.gen.ts";
import {
  VscodeNotebookCellSchema,
  withOptionalNotebookTarget,
  withOptionalNotebookToolbarContext,
} from "./NotebookCommandTarget.ts";

const notebookCommands = {
  createSetupCell: withOptionalNotebookToolbarContext(
    GeneratedMarimoCommands.createSetupCell,
  ),
  publishMarimoNotebook: withOptionalNotebookToolbarContext(
    GeneratedMarimoCommands.publishMarimoNotebook,
  ),
  restartKernel: withOptionalNotebookToolbarContext(
    GeneratedMarimoCommands.restartKernel,
  ),
  runStale: withOptionalNotebookTarget(GeneratedMarimoCommands.runStale),
  showNotebookMenu: withOptionalNotebookToolbarContext(
    GeneratedMarimoCommands.showNotebookMenu,
  ),
  updateActivePythonEnvironment: withOptionalNotebookToolbarContext(
    GeneratedMarimoCommands.updateActivePythonEnvironment,
  ),
};

const cellCommands = {
  hideCellCode: withFirstArgument(
    GeneratedMarimoCommands.hideCellCode,
    VscodeNotebookCellSchema,
  ),
  showCellCode: withFirstArgument(
    GeneratedMarimoCommands.showCellCode,
    VscodeNotebookCellSchema,
  ),
};

const SessionAction = Schema.Struct({
  notebookUri: NotebookIdFromString,
});

/**
 * Commands contributed by this extension, with exceptional contracts refined
 * here. Generated commands use the conventional `[] -> void` contract.
 */
export const MarimoCommands = {
  ...GeneratedMarimoCommands,
  ...notebookCommands,
  ...cellCommands,
  openAsMarimoNotebook: withOptionalFirstArgument(
    GeneratedMarimoCommands.openAsMarimoNotebook,
    Schema.Union(Schema.String, VscodeUriSchema),
  ),
  openSession: withFirstArgument(
    GeneratedMarimoCommands.openSession,
    SessionAction,
  ),
  restartSession: withFirstArgument(
    GeneratedMarimoCommands.restartSession,
    SessionAction,
  ),
  shutdownSession: withFirstArgument(
    GeneratedMarimoCommands.shutdownSession,
    SessionAction,
  ),
  updateCellMetadata: withFirstArgument(
    GeneratedMarimoCommands.updateCellMetadata,
    Schema.String,
  ),
} as const;
