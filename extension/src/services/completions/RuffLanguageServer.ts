import { Data, Effect, Option, Stream } from "effect";
import type * as vscode from "vscode";
import type * as lsp from "vscode-languageclient/node";
import type { Middleware } from "vscode-languageclient/node";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { NamespacedLanguageClient } from "../../utils/NamespacedLanguageClient.ts";
import { Config } from "../Config.ts";
import { Constants } from "../Constants.ts";
import { Uv } from "../Uv.ts";
import { VsCode } from "../VsCode.ts";

export class RuffLanguageServerStartError extends Data.TaggedError(
  "RuffLanguageServerStartError",
)<{
  cause: unknown;
}> {}

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
      const config = yield* Config;
      const code = yield* VsCode;
      const { LanguageId } = yield* Constants;

      const shouldEnableRuffLS =
        yield* config.getManagedLanguageFeaturesEnabled();

      const ruffConfig = yield* code.workspace.getConfiguration("ruff");
      const ruffEnabled = ruffConfig.get<boolean>("enable", true);

      if (!shouldEnableRuffLS || !ruffEnabled) {
        yield* Effect.logInfo(
          "Ruff is disabled. Not starting Ruff language server.",
        );
        return {};
      }

      yield* Effect.logInfo("Starting Ruff language server for marimo");

      // Build initializationOptions from ruff.* settings
      const workspaceFolders = yield* code.workspace.getWorkspaceFolders();
      const settings = Option.getOrElse(workspaceFolders, () => []).map(
        (folder) => getRuffSettings(ruffConfig, folder),
      );
      const globalSettings = getGlobalRuffSettings(ruffConfig);

      yield* Effect.logDebug("Ruff initialization options", {
        settings,
        globalSettings,
      });

      const serverOptions: lsp.ServerOptions = {
        command: uv.bin.executable,
        args: ["tool", "run", "--offline", "ruff", "server"],
        options: {},
      };

      const adapter = new RuffAdapter(LanguageId.Python);
      const middleware: Middleware = {
        notebooks: {
          // Append .ipynb to notebook URI so Ruff recognizes it as a notebook
          // Keep cell URIs unchanged so they match format requests
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
        // Only map languageId, keep URI unchanged to match notebook sync
        provideDocumentFormattingEdits: (document, options, token, next) =>
          next(adapter.document(document), options, token),
        provideDocumentRangeFormattingEdits: (
          document,
          range,
          options,
          token,
          next,
        ) => next(adapter.document(document), range, options, token),
        provideCodeActions: (document, range, context, token, next) =>
          next(adapter.document(document), range, context, token),
      };

      const clientOptions: lsp.LanguageClientOptions = {
        documentSelector: [
          {
            notebook: NOTEBOOK_TYPE,
            // We only want to handle our "custom" language-id with our server
            language: LanguageId.Python,
          },
        ],
        synchronize: {
          fileEvents: [],
        },
        initializationOptions: {
          settings,
          globalSettings,
        },
        middleware,
      };

      const getClient = yield* Effect.cached(
        Effect.tryPromise({
          try: async () => {
            const client = new NamespacedLanguageClient(
              "marimo-ruff",
              "marimo (ruff)",
              serverOptions,
              clientOptions,
              { extraCellLanguages: [LanguageId.Python] },
            );
            await client.start();
            return client;
          },
          catch: (cause) => new RuffLanguageServerStartError({ cause }),
        }).pipe(
          Effect.tapError((error) =>
            Effect.logError("Error starting Ruff language server", { error }),
          ),
          Effect.option,
        ),
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Stopping Ruff language server for marimo");
          const client = yield* getClient;
          if (Option.isSome(client)) {
            yield* Effect.promise(() => client.value.stop());
          }
        }),
      );

      const client = yield* getClient;
      yield* Effect.logInfo(
        client._tag === "Some"
          ? "Ruff language server started successfully"
          : "Ruff language server failed to start",
      );

      // Restart the language server when ruff.* settings change
      yield* Effect.forkScoped(
        code.workspace.configurationChanges().pipe(
          Stream.filter((event) => event.affectsConfiguration("ruff")),
          Stream.mapEffect(() =>
            Effect.gen(function* () {
              const c = yield* getClient;
              if (Option.isNone(c)) {
                return;
              }
              yield* Effect.logInfo(
                "Ruff settings changed, restarting language server...",
              );
              yield* Effect.promise(() => c.value.stop());
              yield* Effect.promise(() => c.value.start());
              yield* Effect.logInfo("Ruff language server restarted");
            }),
          ),
          Stream.runDrain,
        ),
      );

      return {};
    }),
  },
) {}

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
      ignore: config.get("lint.ignore"),
    },
    format: {
      preview: config.get("format.preview"),
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
      ignore: getGlobal("lint.ignore"),
    },
    format: {
      preview: getGlobal("format.preview"),
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
 * Normalizes mo-python language IDs to python and appends .ipynb to notebook URIs.
 */
class RuffAdapter {
  #pythonLanguageId: string;

  constructor(pythonId: string) {
    this.#pythonLanguageId = pythonId;
  }

  #resolveLanguageId(languageId: string): string {
    return languageId === this.#pythonLanguageId ? "python" : languageId;
  }

  /** Appends .ipynb to notebook URI so Ruff recognizes it as a notebook. */
  notebookDocument<T extends { uri: vscode.Uri }>(doc: T): T {
    return { ...doc, uri: doc.uri.with({ path: `${doc.uri.path}.ipynb` }) };
  }

  /**
   * Creates a document proxy that normalizes mo-python to python.
   * Uses Proxy to preserve TextDocument methods while intercepting languageId.
   */
  document(document: vscode.TextDocument): vscode.TextDocument {
    const self = this;
    return new Proxy(document, {
      get(target, prop, receiver) {
        if (prop === "languageId") {
          return self.#resolveLanguageId(target.languageId);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Normalizes mo-python to python on a notebook cell. */
  cell(cell: vscode.NotebookCell): vscode.NotebookCell {
    return {
      ...cell,
      document: {
        ...cell.document,
        languageId: this.#resolveLanguageId(cell.document.languageId),
      },
    };
  }

  /** Normalizes mo-python to python on all cells in a notebook change event. */
  cellsEvent(
    cells: lsp.VNotebookDocumentChangeEvent["cells"],
  ): lsp.VNotebookDocumentChangeEvent["cells"] {
    if (!cells) {
      return {};
    }

    const result: lsp.VNotebookDocumentChangeEvent["cells"] = {};
    const { textContent, data, structure } = cells;

    if (textContent) {
      result.textContent = textContent.map((change) => ({
        ...change,
        document: {
          ...change.document,
          languageId: this.#resolveLanguageId(change.document.languageId),
        },
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
