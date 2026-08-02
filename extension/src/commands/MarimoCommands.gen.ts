// AUTO-GENERATED FILE — DO NOT EDIT.
//
// Generated from `extension/package.json` by `scripts.codegen`.
// Regenerate with `just codegen`.
import { marimoCommand } from "../commands.ts";

export const GeneratedMarimoCommands = {
  clearRecentNotebooks: marimoCommand("marimo.clearRecentNotebooks"),
  configToggleAutoReloadAutorun: marimoCommand(
    "marimo.config.toggleAutoReloadAutorun",
  ),
  configToggleAutoReloadLazy: marimoCommand(
    "marimo.config.toggleAutoReloadLazy",
  ),
  configToggleAutoReloadOff: marimoCommand("marimo.config.toggleAutoReloadOff"),
  configToggleOnCellChangeAutoRun: marimoCommand(
    "marimo.config.toggleOnCellChangeAutoRun",
  ),
  configToggleOnCellChangeLazy: marimoCommand(
    "marimo.config.toggleOnCellChangeLazy",
  ),
  configureAutoExport: marimoCommand("marimo.configureAutoExport"),
  createSetupCell: marimoCommand("marimo.createSetupCell"),
  debugCell: marimoCommand("marimo.debugCell"),
  exportStaticHTML: marimoCommand("marimo.exportStaticHTML"),
  newMarimoNotebook: marimoCommand("marimo.newMarimoNotebook"),
  openAsMarimoNotebook: marimoCommand("marimo.openAsMarimoNotebook"),
  openOutlineView: marimoCommand("marimo.openOutlineView"),
  openTutorial: marimoCommand("marimo.openTutorial"),
  publishMarimoNotebook: marimoCommand("marimo.publishMarimoNotebook"),
  publishMarimoNotebookGist: marimoCommand("marimo.publishMarimoNotebookGist"),
  refreshPackages: marimoCommand("marimo.refreshPackages"),
  reportIssue: marimoCommand("marimo.reportIssue"),
  restartKernel: marimoCommand("marimo.restartKernel"),
  restartLsp: marimoCommand("marimo.restartLsp"),
  runStale: marimoCommand("marimo.runStale"),
  showDiagnostics: marimoCommand("marimo.showDiagnostics"),
  showMarimoMenu: marimoCommand("marimo.showMarimoMenu"),
  updateActivePythonEnvironment: marimoCommand(
    "marimo.updateActivePythonEnvironment",
  ),
} as const;
