import { Schema } from "effect";

import {
  withFirstArgument,
  withOptionalNotebookContext,
  VscodeUriSchema,
} from "../commands.ts";
import { GeneratedMarimoCommands } from "./MarimoCommands.gen.ts";

const notebookCommands = {
  configToggleAutoReloadAutorun: withOptionalNotebookContext(
    GeneratedMarimoCommands.configToggleAutoReloadAutorun,
  ),
  configToggleAutoReloadLazy: withOptionalNotebookContext(
    GeneratedMarimoCommands.configToggleAutoReloadLazy,
  ),
  configToggleAutoReloadOff: withOptionalNotebookContext(
    GeneratedMarimoCommands.configToggleAutoReloadOff,
  ),
  configToggleOnCellChangeAutoRun: withOptionalNotebookContext(
    GeneratedMarimoCommands.configToggleOnCellChangeAutoRun,
  ),
  configToggleOnCellChangeLazy: withOptionalNotebookContext(
    GeneratedMarimoCommands.configToggleOnCellChangeLazy,
  ),
  configureAutoExport: withOptionalNotebookContext(
    GeneratedMarimoCommands.configureAutoExport,
  ),
  restartKernel: withOptionalNotebookContext(
    GeneratedMarimoCommands.restartKernel,
  ),
  runStale: withOptionalNotebookContext(GeneratedMarimoCommands.runStale),
};

/**
 * Commands contributed by this extension, with exceptional contracts refined
 * here. Generated commands use the conventional `[] -> void` contract.
 */
export const MarimoCommands = {
  ...GeneratedMarimoCommands,
  ...notebookCommands,
  openAsMarimoNotebook: withFirstArgument(
    GeneratedMarimoCommands.openAsMarimoNotebook,
    Schema.UndefinedOr(Schema.Union(Schema.String, VscodeUriSchema)),
  ),
} as const;
