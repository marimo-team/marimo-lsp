import { Schema } from "effect";

import {
  withFirstArgument,
  withOptionalNotebookContext,
  VscodeNotebookCellSchema,
  VscodeUriSchema,
} from "../commands.ts";
import { NotebookIdFromString } from "../schemas/MarimoNotebookDocument.ts";
import { GeneratedMarimoCommands } from "./MarimoCommands.gen.ts";

const notebookCommands = {
  createSetupCell: withOptionalNotebookContext(
    GeneratedMarimoCommands.createSetupCell,
  ),
  publishMarimoNotebook: withOptionalNotebookContext(
    GeneratedMarimoCommands.publishMarimoNotebook,
  ),
  restartKernel: withOptionalNotebookContext(
    GeneratedMarimoCommands.restartKernel,
  ),
  runStale: withOptionalNotebookContext(GeneratedMarimoCommands.runStale),
  showNotebookMenu: withOptionalNotebookContext(
    GeneratedMarimoCommands.showNotebookMenu,
  ),
  updateActivePythonEnvironment: withOptionalNotebookContext(
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
  openAsMarimoNotebook: withFirstArgument(
    GeneratedMarimoCommands.openAsMarimoNotebook,
    Schema.UndefinedOr(Schema.Union(Schema.String, VscodeUriSchema)),
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
