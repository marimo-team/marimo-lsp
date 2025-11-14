import { Effect, Layer, Stream } from "effect";
import * as vscode from "vscode";
import { TopologicalOrderTracker } from "../services/completions/TopologicalOrderTracker";
import { VirtualDocumentProvider } from "../services/completions/VirtualDocumentProvider";
import { PyrightProxy } from "../services/completions/PyrightProxy";
import { NotebookLspCoordinator } from "../services/completions/NotebookLspCoordinator";
import { VariablesService } from "../services/variables/VariablesService";
import { getNotebookUri } from "../types";

/**
 * Layer that sets up LSP integration for marimo notebooks.
 *
 * This layer:
 * 1. Creates execution order tracker
 * 2. Creates virtual document provider
 * 3. Creates Pyright proxy
 * 4. Creates and initializes the LSP coordinator
 * 5. Registers language feature providers
 * 6. Subscribes to variable changes to update cell ordering
 */
export const NotebookLspCoordinatorLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* Effect.logInfo("Setting up LSP coordinator");

    // Get VariablesService from context
    const variablesService = yield* VariablesService;

    // Create services
    const topologicalOrderTracker = new TopologicalOrderTracker();
    const virtualDocumentProvider = new VirtualDocumentProvider(
      topologicalOrderTracker
    );
    const pyrightProxy = new PyrightProxy(
      virtualDocumentProvider,
      topologicalOrderTracker
    );

    // Note: We no longer register a TextDocumentContentProvider
    // because we use temporary files instead of virtual documents

    // Create coordinator
    const coordinator = new NotebookLspCoordinator(
      topologicalOrderTracker,
      virtualDocumentProvider,
      pyrightProxy
    );

    // Register language feature providers
    coordinator.registerLanguageFeatureProviders();

    // Subscribe to variable changes and update the topological order tracker
    // This will automatically update the virtual document when variables change
    const variablesChangesStream = variablesService.streamVariablesChanges();
    yield* Effect.forkScoped(
      Stream.runForEach(variablesChangesStream, (variablesMap) =>
        Effect.gen(function* () {
          // For each notebook with variables, update the topological order tracker
          for (const notebook of vscode.workspace.notebookDocuments) {
            const notebookUri = getNotebookUri(notebook);
            const variablesOp = yield* variablesService.getVariables(notebookUri);

            // Update the topological order tracker with new variables
            topologicalOrderTracker.updateVariablesFromOption(notebook, variablesOp);

            // Update the virtual document if it exists
            if (virtualDocumentProvider.hasVirtualDocument(notebook)) {
              yield* Effect.sync(() => pyrightProxy.updateNotebook(notebook));
            }
          }
        })
      )
    );

    yield* Effect.logInfo("LSP coordinator initialized with variable tracking");

    // Set up disposal
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        coordinator.dispose();
        virtualDocumentProvider.dispose(); // Clean up temp files
      })
    );
  })
);
