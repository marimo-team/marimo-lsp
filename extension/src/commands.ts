export type DynamicCommand = `marimo.dynamic.${string}`;

export function dynamicCommand(command: string): DynamicCommand {
  return `marimo.dynamic.${command}` as DynamicCommand;
}

// Pulled from https://code.visualstudio.com/api/references/commands
export type VscodeBuiltinCommand =
  // Invoke notebook serializer
  | "vscode.executeDataToNotebook"
  // Invoke notebook serializer
  | "vscode.executeNotebookToData"
  // Trigger kernel picker for specified notebook editor widget
  | "notebook.selectKernel"
  // Open interactive window and return notebook editor and input URI
  | "interactive.open"
  // Invoke a new editor chat session
  | "vscode.editorChat.start"
  // Execute document highlight provider.
  | "vscode.executeDocumentHighlights"
  // Execute document symbol provider.
  | "vscode.executeDocumentSymbolProvider"
  // Execute document format provider.
  | "vscode.executeFormatDocumentProvider"
  // Execute range format provider.
  | "vscode.executeFormatRangeProvider"
  // Execute format on type provider.
  | "vscode.executeFormatOnTypeProvider"
  // Execute all definition providers.
  | "vscode.executeDefinitionProvider"
  // Execute all type definition providers.
  | "vscode.executeTypeDefinitionProvider"
  // Execute all declaration providers.
  | "vscode.executeDeclarationProvider"
  // Execute all implementation providers.
  | "vscode.executeImplementationProvider"
  // Execute all reference providers.
  | "vscode.executeReferenceProvider"
  // Execute all hover providers.
  | "vscode.executeHoverProvider"
  // Execute selection range provider.
  | "vscode.executeSelectionRangeProvider"
  // Execute all workspace symbol providers.
  | "vscode.executeWorkspaceSymbolProvider"
  // Prepare call hierarchy at a position inside a document
  | "vscode.prepareCallHierarchy"
  // Compute incoming calls for an item
  | "vscode.provideIncomingCalls"
  // Compute outgoing calls for an item
  | "vscode.provideOutgoingCalls"
  // Execute the prepareRename of rename provider.
  | "vscode.prepareRename"
  // Execute rename provider.
  | "vscode.executeDocumentRenameProvider"
  // Execute document link provider.
  | "vscode.executeLinkProvider"
  // Provide semantic tokens legend for a document
  | "vscode.provideDocumentSemanticTokensLegend"
  // Provide semantic tokens for a document
  | "vscode.provideDocumentSemanticTokens"
  // Provide semantic tokens legend for a document range
  | "vscode.provideDocumentRangeSemanticTokensLegend"
  // Provide semantic tokens for a document range
  | "vscode.provideDocumentRangeSemanticTokens"
  // Execute completion item provider.
  | "vscode.executeCompletionItemProvider"
  // Execute signature help provider.
  | "vscode.executeSignatureHelpProvider"
  // Execute code lens provider.
  | "vscode.executeCodeLensProvider"
  // Execute code action provider.
  | "vscode.executeCodeActionProvider"
  // Execute document color provider.
  | "vscode.executeDocumentColorProvider"
  // Execute color presentation provider.
  | "vscode.executeColorPresentationProvider"
  // Execute inlay hints provider
  | "vscode.executeInlayHintProvider"
  // Execute folding range provider
  | "vscode.executeFoldingRangeProvider"
  // Resolve Notebook Content Providers
  | "vscode.resolveNotebookContentProviders"
  // Execute inline value provider
  | "vscode.executeInlineValueProvider"
  // Opens the provided resource in the editor. Can be a text or binary file, or an http(s) URL. If you need more control over the options for opening a text file, use "vscode.window.showTextDocument</code> instead."
  | "vscode.open"
  // Opens the provided resource with a specific editor.
  | "vscode.openWith"
  // Opens the provided resources in the diff editor to compare their contents.
  | "vscode.diff"
  // Opens a list of resources in the changes editor to compare their contents.
  | "vscode.changes"
  // Prepare type hierarchy at a position inside a document
  | "vscode.prepareTypeHierarchy"
  // Compute supertypes for an item
  | "vscode.provideSupertypes"
  // Compute subtypes for an item
  | "vscode.provideSubtypes"
  // Reveals a test instance in the explorer
  | "vscode.revealTestInExplorer"
  // Set a custom context key value that can be used in when clauses.
  | "setContext"
  // Move cursor to a logical position in the view
  | "cursorMove"
  // Scroll editor in the given direction
  | "editorScroll"
  // Reveal the given line at the given logical position
  | "revealLine"
  // Unfold the content in the editor
  | "editor.unfold"
  // Fold the content in the editor
  | "editor.fold"
  // Folds or unfolds the content in the editor depending on its current state
  | "editor.toggleFold"
  // Open a new In-Editor Find Widget with specific options.
  | "editor.actions.findWithArgs"
  // Go to locations from a position in a file
  | "editor.action.goToLocations"
  // Peek locations from a position in a file
  | "editor.action.peekLocations"
  // Quick access
  | "workbench.action.quickOpen"
  // Toggle Outputs
  | "notebook.cell.toggleOutputs"
  // Fold Cell
  | "notebook.fold"
  // Unfold Cell
  | "notebook.unfold"
  // Notebook Kernel Args
  | "notebook.selectKernel"
  // Change Cell Language
  | "notebook.cell.changeLanguage"
  // Run All
  | "notebook.execute"
  // Execute Cell
  | "notebook.cell.execute"
  // Execute Cell and Focus Container
  | "notebook.cell.executeAndFocusContainer"
  // Stop Cell Execution
  | "notebook.cell.cancelExecution"
  // Open a workspace search
  | "workbench.action.findInFiles"
  // Open Interactive Window
  | "_interactive.open"
  // Execute the Contents of the Input Box
  | "interactive.execute"
  // Open a new search editor. Arguments passed can include variables like ${relativeFileDirname}.
  | "search.action.openNewEditor"
  // Open a new search editor. Arguments passed can include variables like ${relativeFileDirname}.
  | "search.action.openEditor"
  // Open a new search editor. Arguments passed can include variables like ${relativeFileDirname}.
  | "search.action.openNewEditorToSide"
  // Open a folder or workspace in the current window or new window depending on the newWindow argument.
  | "vscode.openFolder"
  // Opens an new window depending on the newWindow argument.
  | "vscode.newWindow"
  // Removes an entry with the given path from the recently opened list.
  | "vscode.removeFromRecentlyOpened"
  // Move the active editor by tabs or groups
  | "moveActiveEditor"
  // Copy the active editor by groups
  | "copyActiveEditor"
  // Get Editor Layout
  | "vscode.getEditorLayout"
  // New Untitled Text File
  | "workbench.action.files.newUntitledFile"
  // Install the given extension
  | "workbench.extensions.installExtension"
  // Uninstall the given extension
  | "workbench.extensions.uninstallExtension"
  // Search for a specific extension
  | "workbench.extensions.search"
  // Run Task
  | "workbench.action.tasks.runTask"
  // Open the issue reporter and optionally prefill part of the form.
  | "workbench.action.openIssueReporter"
  // Open the issue reporter and optionally prefill part of the form.
  | "vscode.openIssueReporter"
  // workbench.action.openLogFile
  | "workbench.action.openLogFile"
  // Open the walkthrough.
  | "workbench.action.openWalkthrough"
  // Close active editor
  | "workbench.action.closeActiveEditor"
  // Open settings
  | "workbench.action.openSettings";
