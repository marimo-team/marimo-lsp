import * as lsp from "vscode-languageclient/node";
import type * as proto from "vscode-languageserver-protocol";

/**
 * LanguageClient that namespaces LSP executeCommand registrations on the client
 * and transparently strips the namespace before forwarding commands to the server.
 *
 * This is used to avoid command name collisions when multiple language clients
 * are active in the same VS Code environment. Commands are registered with a
 * client-specific prefix, while the server continues to operate on unprefixed
 * command names.
 *
 * The transformation is symmetric:
 * - Incoming command registrations are prefixed on registration
 * - Outgoing executeCommand requests have the prefix removed
 *
 * Additionally, this client intercepts server capabilities to extend the
 * notebook document sync selector to include custom language IDs (like mo-python).
 */
export class NamespacedLanguageClient extends lsp.LanguageClient {
  #prefix: string;
  #extraCellLanguages: string[];

  constructor(
    id: string,
    name: string,
    serverOptions: lsp.ServerOptions,
    clientOptions: lsp.LanguageClientOptions,
    options?: { extraCellLanguages?: string[] },
  ) {
    // Just use the client ID as the prefix
    const prefix = `${id}.`;
    super(id, name, serverOptions, {
      ...clientOptions,
      middleware: {
        ...clientOptions.middleware,
        executeCommand: (command, args, next) => {
          return next(
            command.startsWith(prefix) ? command.slice(prefix.length) : command,
            args,
          );
        },
      },
    });
    this.#prefix = prefix;
    this.#extraCellLanguages = options?.extraCellLanguages ?? [];
  }

  /**
   * Intercepts the initialize result to extend the notebook document sync
   * selector with additional cell languages. This allows our middleware to
   * transform custom language IDs (like mo-python) before sending to the server.
   */
  protected override async doInitialize(
    connection: lsp.MessageConnection,
    initParams: proto.InitializeParams,
  ): Promise<proto.InitializeResult> {
    // @ts-expect-error - accessing protected method on parent
    const result = await super.doInitialize(connection, initParams);

    // Extend notebook selector to include extra cell languages
    if (
      this.#extraCellLanguages.length > 0 &&
      result.capabilities?.notebookDocumentSync
    ) {
      const sync = result.capabilities.notebookDocumentSync;
      const options = "notebookSelector" in sync ? sync : undefined;
      if (options?.notebookSelector) {
        for (const selector of options.notebookSelector) {
          if ("cells" in selector && selector.cells) {
            // Add extra languages to each cell selector
            for (const lang of this.#extraCellLanguages) {
              selector.cells.push({ language: lang });
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Prefixes executeCommand registrations with the client namespace.
   *
   * Commands are rewritten at registration time to avoid collisions in the
   * client, and later un-prefixed by the executeCommand middleware before
   * being sent to the server.
   */
  override registerFeature(
    feature: lsp.StaticFeature | lsp.DynamicFeature<unknown>,
  ): void {
    if (isCommandRegistrationFeature(feature)) {
      const originalRegister = feature.register.bind(feature);
      feature.register = (data) => {
        data.registerOptions.commands = data.registerOptions.commands.map(
          (cmd) => `${this.#prefix}${cmd}`,
        );
        originalRegister(data);
      };
    }
    super.registerFeature(feature);
  }
}

function isCommandRegistrationFeature(
  feature: lsp.StaticFeature | lsp.DynamicFeature<unknown>,
): feature is lsp.DynamicFeature<lsp.ExecuteCommandRegistrationOptions> {
  return (
    "registrationType" in feature &&
    feature.registrationType.method === lsp.ExecuteCommandRequest.method
  );
}
