import { Data, Effect, Either, Option, Runtime, Stream } from "effect";
import type * as vscode from "vscode";
import type * as lsp from "vscode-languageclient/node";
import { NamespacedLanguageClient } from "../../utils/NamespacedLanguageClient.ts";
import { Config } from "../Config.ts";
import { Constants } from "../Constants.ts";
import { Uv } from "../Uv.ts";
import { VsCode } from "../VsCode.ts";

// Pin Ruff version for stability, matching ruff-vscode's approach.
// Bump this as needed for new features or fixes.
const RUFF_VERSION = "0.11.13";
const RUFF_EXTENSION_ID = "charliermarsh.ruff";

export class RuffLanguageServerStartError extends Data.TaggedError(
  "RuffLanguageServerStartError",
)<{
  cause: unknown;
}> {}

export const RuffLanguageServerHealth =
  Data.taggedEnum<RuffLanguageServerHealth>();

type RuffLanguageServerHealth = Data.TaggedEnum<{
  Running: { readonly version: Option.Option<string> };
  Failed: { readonly error: string };
}>;

/**
 * Manages a dedicated Ruff language server instance (using ruff via uvx)
 * for marimo notebooks. Provides linting diagnostics for notebook cells.
 *
 * Ruff has native notebook support. We configure automatic notebook sync
 * and use middleware to map mo-python -> python language IDs.
 */
export class RuffLanguageServer extends Effect.Service<RuffLanguageServer>()(
  "RuffLanguageServer",
  {
    scoped: Effect.gen(function* () {
      const uv = yield* Uv;
      const code = yield* VsCode;
      const { LanguageId } = yield* Constants;

      const disabledHealth = yield* checkRuffEnabled();
      if (Option.isSome(disabledHealth)) {
        return {
          getHealthStatus: Effect.succeed(disabledHealth.value),
        };
      }

      yield* Effect.logInfo("Starting Ruff language server for marimo");

      // Build initializationOptions from ruff.* settings
      const ruffConfig = yield* code.workspace.getConfiguration("ruff");
      const workspaceFolders = yield* code.workspace.getWorkspaceFolders();
      const settings = Option.getOrElse(workspaceFolders, () => []).map(
        (folder) => getRuffSettings(ruffConfig, folder),
      );
      const globalSettings = getGlobalRuffSettings(ruffConfig);

      yield* Effect.logDebug("Ruff initialization options", {
        settings,
        globalSettings,
      });

      const runtime = yield* Effect.runtime<VsCode>();
      const runPromise = Runtime.runPromise(runtime);

      const clientOptions: lsp.LanguageClientOptions = {
        outputChannelName: "marimo (ruff)",
        middleware: createRuffAdapterMiddleware(LanguageId.Python, {
          // We should only format if Ruff is the default formatter for Python
          shouldFormat: () =>
            ruffConfiguredAsDefaultPythonFormatter().pipe(
              Effect.tap((enabled) =>
                enabled
                  ? Effect.void
                  : Effect.logWarning(
                      `Ruff is not configured as default Python formatter; skipping marimo format.`,
                    ),
              ),
              runPromise,
            ),
        }),
        documentSelector: isVirtualWorkspace(workspaceFolders)
          ? [{ language: LanguageId.Python }]
          : [
              { scheme: "file", language: LanguageId.Python },
              { scheme: "untitled", language: LanguageId.Python },
              { scheme: "vscode-notebook", language: LanguageId.Python },
              { scheme: "vscode-notebook-cell", language: LanguageId.Python },
            ],
        initializationOptions: { settings, globalSettings },
        // Extend ruff's notebook sync selector to include mo-python cells
        transformServerCapabilities: extendNotebookCellLanguages(
          LanguageId.Python,
        ),
      };

      const serverOptions: lsp.ServerOptions = {
        command: uv.bin.executable,
        args: ["tool", "run", `ruff@${RUFF_VERSION}`, "server"],
        options: {},
      };

      const getClient = yield* Effect.tryPromise({
        try: async () => {
          const client = new NamespacedLanguageClient(
            "marimo-ruff",
            "marimo (ruff)",
            serverOptions,
            clientOptions,
          );
          await client.start();
          return client;
        },
        catch: (cause) => new RuffLanguageServerStartError({ cause }),
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError("Error starting Ruff language server", { error }),
        ),
        Effect.either,
        Effect.cached,
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Stopping Ruff language server for marimo");
          const client = yield* getClient;
          if (Either.isRight(client)) {
            yield* Effect.promise(() => client.right.stop());
          }
        }),
      );

      const restartServer = Effect.fn(function* () {
        const c = yield* getClient;
        if (Either.isLeft(c)) {
          return;
        }
        yield* Effect.logInfo("Restarting Ruff language server for marimo");
        yield* Effect.promise(() => c.right.stop());
        yield* Effect.promise(() => c.right.start());
        yield* Effect.logInfo("Ruff language server for marimo restarted");
      });

      const client = yield* getClient;
      yield* Effect.logInfo(
        Either.isRight(client)
          ? "Ruff language server started successfully"
          : "Ruff language server failed to start",
      );

      // Restart the language server when ruff.* settings change
      yield* Effect.forkScoped(
        code.workspace.configurationChanges().pipe(
          Stream.filter((event) => event.affectsConfiguration("ruff")),
          Stream.mapEffect(restartServer),
          Stream.runDrain,
        ),
      );

      return {
        getHealthStatus: Effect.gen(function* () {
          const c = yield* getClient;
          return Either.match(c, {
            onLeft: (error) =>
              RuffLanguageServerHealth.Failed({
                error: String(error.cause),
              }),
            onRight: (client) =>
              RuffLanguageServerHealth.Running({
                version: Option.fromNullable(
                  client.initializeResult?.serverInfo?.version,
                ),
              }),
          });
        }),
      };
    }),
  },
) {}

/**
 * Ruff rules that depend on cross-cell ordering.
 *
 * These rules assume top-down execution order, but marimo cells execute based
 * on their dependency graph. Properly supporting these rules is challenging—
 * we'd need middleware to present cells in topological order, or work with
 * Astral on cell dependency metadata.
 *
 * For now, we ignore these rules to provide Ruff linting today. The trade-off
 * is that we also miss legitimate violations within a single cell.
 */
const CELL_ORDERING_IGNORES = [
  "F401", // unused-import: import may be used in a dependent cell
  "F841", // unused-variable: variable may be used in a dependent cell
  "F842", // unused-annotation: annotation may be used in a dependent cell
  "F821", // undefined-name: name may be defined in a cell that executes first
  "F811", // redefined-while-unused: may be used in another cell
];

/**
 * Read ruff.* settings from a WorkspaceConfiguration and return them in the format
 * expected by the Ruff language server's initializationOptions.
 *
 * Based on ruff-vscode's getWorkspaceSettings:
 * https://github.com/astral-sh/ruff-vscode/blob/main/src/common/settings.ts
 */
function getRuffSettings(
  config: vscode.WorkspaceConfiguration,
  folder: vscode.WorkspaceFolder,
): Record<string, unknown> {
  return {
    cwd: folder.uri.fsPath,
    workspace: folder.uri.toString(),
    configuration: config.get("configuration") ?? null,
    configurationPreference:
      config.get("configurationPreference") ?? "editorFirst",
    lineLength: config.get("lineLength"),
    exclude: config.get("exclude"),
    lint: {
      enable: config.get("lint.enable") ?? true,
      preview: config.get("lint.preview"),
      select: config.get("lint.select"),
      extendSelect: config.get("lint.extendSelect"),
      ignore: [
        ...new Set([
          ...(config.get<string[]>("lint.ignore") ?? []),
          ...CELL_ORDERING_IGNORES,
        ]),
      ],
    },
    format: {
      preview: config.get("format.preview"),
      backend: config.get("format.backend") ?? "internal",
    },
    codeAction: config.get("codeAction") ?? {},
    organizeImports: config.get("organizeImports") ?? true,
    fixAll: config.get("fixAll") ?? true,
    showSyntaxErrors: config.get("showSyntaxErrors") ?? true,
    logLevel: config.get("logLevel"),
    logFile: config.get("logFile"),
  };
}

/**
 * Read global ruff.* settings (not workspace-specific).
 *
 * Based on ruff-vscode's getGlobalSettings:
 * https://github.com/astral-sh/ruff-vscode/blob/main/src/common/settings.ts
 */
function getGlobalRuffSettings(
  config: vscode.WorkspaceConfiguration,
): Record<string, unknown> {
  const getGlobal = <T>(key: string, defaultValue?: T): T | undefined => {
    const inspect = config.inspect<T>(key);
    return inspect?.globalValue ?? inspect?.defaultValue ?? defaultValue;
  };
  return {
    cwd: process.cwd(),
    workspace: process.cwd(),
    configuration: getGlobal("configuration", null),
    configurationPreference: getGlobal(
      "configurationPreference",
      "editorFirst",
    ),
    lineLength: getGlobal("lineLength"),
    exclude: getGlobal("exclude"),
    lint: {
      enable: getGlobal("lint.enable", true),
      preview: getGlobal("lint.preview"),
      select: getGlobal("lint.select"),
      extendSelect: getGlobal("lint.extendSelect"),
      ignore: [
        ...new Set([
          ...(getGlobal<string[]>("lint.ignore") ?? []),
          ...CELL_ORDERING_IGNORES,
        ]),
      ],
    },
    format: {
      preview: getGlobal("format.preview"),
      backend: getGlobal("format.backend", "internal"),
    },
    codeAction: getGlobal("codeAction", {}),
    organizeImports: getGlobal("organizeImports", true),
    fixAll: getGlobal("fixAll", true),
    showSyntaxErrors: getGlobal("showSyntaxErrors", true),
    logLevel: getGlobal("logLevel"),
    logFile: getGlobal("logFile"),
  };
}

/**
 * Adapts marimo notebook documents and cells for Ruff compatibility.
 *
 * Key insight: Ruff uses `key_from_url` which checks if a URL path ends with `.ipynb`
 * to determine if it's a notebook. We must:
 * - Append `.ipynb` to the NOTEBOOK document URI so Ruff treats it as a notebook
 * - NOT append `.ipynb` to CELL document URIs, so they aren't mistaken for notebooks
 * - Normalize mo-python -> python language ID
 *
 * @internal Exported for testing
 */
export class RuffAdapter {
  #pythonLanguageId: string;

  constructor(pythonId: string) {
    this.#pythonLanguageId = pythonId;
  }

  #resolveLanguageId(languageId: string): string {
    return languageId === this.#pythonLanguageId ? "python" : languageId;
  }

  /** Appends .ipynb to notebook URI so Ruff recognizes it as a notebook. */
  notebookDocument<T extends { uri: vscode.Uri }>(doc: T): T {
    const wrapped = Object.create(doc);
    Object.defineProperty(wrapped, "uri", {
      value: doc.uri.with({ path: `${doc.uri.path}.ipynb` }),
      enumerable: true,
      configurable: true,
    });
    return wrapped;
  }

  /**
   * Creates a document wrapper that normalizes mo-python to python.
   * Does NOT modify the URI - cell URIs should stay as-is so Ruff doesn't
   * mistake them for notebook documents.
   */
  document(document: vscode.TextDocument): vscode.TextDocument {
    const wrapped = Object.create(document);
    Object.defineProperty(wrapped, "languageId", {
      value: this.#resolveLanguageId(document.languageId),
      enumerable: true,
      configurable: true,
    });
    return wrapped;
  }

  /**
   * Adapts a notebook cell for notebook document sync messages.
   * - Transforms the notebook URI to include .ipynb
   * - Normalizes the cell document language ID (but NOT the URI)
   */
  cell(cell: vscode.NotebookCell): vscode.NotebookCell {
    return {
      ...cell,
      notebook: this.notebookDocument(cell.notebook),
      document: this.document(cell.document),
    };
  }

  /** Normalizes mo-python to python on all cells in a notebook change event. */
  cellsEvent(
    cells: lsp.VNotebookDocumentChangeEvent["cells"],
  ): lsp.VNotebookDocumentChangeEvent["cells"] {
    if (!cells) {
      return undefined;
    }

    const result: lsp.VNotebookDocumentChangeEvent["cells"] = {};
    const { textContent, data, structure } = cells;

    if (textContent) {
      result.textContent = textContent.map((change) => ({
        ...change,
        document: this.document(change.document),
      }));
    }

    if (data) {
      result.data = data.map((cell) => this.cell(cell));
    }

    if (structure) {
      result.structure = {
        array: {
          ...structure.array,
          cells: structure.array.cells?.map((cell) => this.cell(cell)),
        },
        didOpen: structure.didOpen?.map((cell) => this.cell(cell)),
        didClose: structure.didClose?.map((cell) => this.cell(cell)),
      };
    }

    return result;
  }
}

/**
 * Creates a transform function that extends notebook document sync selectors
 * to include additional cell languages.
 *
 * NOTE: Mutates the capabilities object in-place.
 *
 * @internal Exported for testing
 */
export function extendNotebookCellLanguages(
  language: string,
): (capabilities: lsp.ServerCapabilities) => lsp.ServerCapabilities {
  return (capabilities) => {
    const sync = capabilities.notebookDocumentSync;
    if (sync && "notebookSelector" in sync) {
      for (const selector of sync.notebookSelector) {
        if ("cells" in selector && selector.cells) {
          selector.cells.push({ language });
        }
      }
    }
    return capabilities;
  };
}

function isVirtualWorkspace(
  workspaceFolders: Option.Option<ReadonlyArray<vscode.WorkspaceFolder>>,
): boolean {
  return Option.match(workspaceFolders, {
    onSome: (folders) => folders.every((f) => f.uri.scheme !== "file"),
    onNone: () => false,
  });
}

/**
 * Creates LSP middleware that adapts marimo notebook documents for Ruff.
 *
 * Background: marimo notebooks use a custom language ID (e.g., "mo-python") for
 * Python cells. This prevents VS Code's built-in Python language servers from
 * activating on marimo notebooks, giving us control over which language features
 * are enabled. However, Ruff only processes cells with languageId "python" and
 * ignores anything else.
 *
 * Additionally, Ruff determines whether a document is a notebook by checking if
 * the URI path ends with `.ipynb`. marimo notebook files use `.py` extensions,
 * so Ruff wouldn't recognize them as notebooks without intervention.
 *
 * This middleware intercepts LSP requests and transforms them before Ruff sees them:
 * - Appends `.ipynb` to notebook document URIs so Ruff treats them as notebooks
 * - Normalizes the custom language ID to "python" so Ruff processes the cells
 * - Leaves cell URIs unchanged (only notebook URIs need the .ipynb suffix)
 *
 * @see https://github.com/astral-sh/ruff/pull/11206 - Ruff's notebook support
 *
 *
 * @param pythonLanguageId The custom language ID used for Python cells in marimo notebooks (e.g., "mo-python").
 * @param config.shouldFormat Async function that returns whether formatting should be applied.
 */
function createRuffAdapterMiddleware(
  pythonLanguageId: string,
  config: {
    shouldFormat: () => Promise<boolean>;
  },
): lsp.Middleware {
  const adapter = new RuffAdapter(pythonLanguageId);
  return {
    didOpen: (document, next) => next(adapter.document(document)),
    didClose: (document, next) => next(adapter.document(document)),
    didChange: (change, next) =>
      next({
        ...change,
        document: adapter.document(change.document),
      }),
    notebooks: {
      didOpen: (doc, cells, next) =>
        next(
          adapter.notebookDocument(doc),
          cells.map((cell) => adapter.cell(cell)),
        ),
      didClose: (doc, cells, next) =>
        next(
          adapter.notebookDocument(doc),
          cells.map((cell) => adapter.cell(cell)),
        ),
      didChange: (event, next) =>
        next({
          notebook: adapter.notebookDocument(event.notebook),
          metadata: event.metadata,
          cells: adapter.cellsEvent(event.cells),
        }),
    },
    async provideDocumentFormattingEdits(document, options, token, next) {
      const shouldFormat = await config.shouldFormat();
      return shouldFormat
        ? next(adapter.document(document), options, token)
        : null;
    },
    async provideDocumentRangeFormattingEdits(
      document,
      range,
      options,
      token,
      next,
    ) {
      const shouldFormat = await config.shouldFormat();
      return shouldFormat
        ? next(adapter.document(document), range, options, token)
        : null;
    },
    provideCodeActions: (document, range, context, token, next) =>
      next(adapter.document(document), range, context, token),
  };
}

/**
 * Checks if the managed Ruff language server should be enabled.
 * Returns Some(FailedHealth) if disabled, None if enabled.
 */
const checkRuffEnabled = Effect.fn(function* () {
  const code = yield* VsCode;
  const config = yield* Config;

  const managedFeaturesEnabled =
    yield* config.getManagedLanguageFeaturesEnabled();

  if (!managedFeaturesEnabled) {
    yield* Effect.logInfo(
      "Managed language features are disabled. Not starting managed Ruff language server.",
    );
    return Option.some(
      RuffLanguageServerHealth.Failed({
        error: "Managed language features are disabled in marimo settings.",
      }),
    );
  }

  const ruffExtension = code.extensions.getExtension(RUFF_EXTENSION_ID);
  if (Option.isNone(ruffExtension)) {
    yield* Effect.logInfo(
      "Ruff extension is not installed. Not starting managed Ruff language server.",
    );
    return Option.some(
      RuffLanguageServerHealth.Failed({
        error: `Ruff extension (${RUFF_EXTENSION_ID}) is not installed.`,
      }),
    );
  }

  const ruffConfig = yield* code.workspace.getConfiguration("ruff");
  const ruffEnabled = ruffConfig.get<boolean>("enable", true);

  if (!ruffEnabled) {
    yield* Effect.logInfo(
      "Ruff extension is disabled via ruff.enable setting. Not starting managed Ruff language server.",
    );
    return Option.some(
      RuffLanguageServerHealth.Failed({
        error: "Ruff extension is disabled (ruff.enable = false).",
      }),
    );
  }

  return Option.none();
});

/**
 * Checks if Ruff is configured as the default Python formatter in VS Code settings.
 *
 * Ref: https://github.com/astral-sh/ruff-vscode?tab=readme-ov-file#configuring-vs-code
 */
const ruffConfiguredAsDefaultPythonFormatter = Effect.fn(function* () {
  const code = yield* VsCode;
  const pythonConfig = yield* code.workspace.getConfiguration("", {
    languageId: "python",
  });
  return (
    pythonConfig.get<unknown>("editor.defaultFormatter") === RUFF_EXTENSION_ID
  );
});
