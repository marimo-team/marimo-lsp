import * as lsp from "vscode-languageclient/node";

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
 */
export class NamespacedLanguageClient extends lsp.LanguageClient {
  #prefix: string;

  constructor(
    id: string,
    name: string,
    serverOptions: lsp.ServerOptions,
    clientOptions: lsp.LanguageClientOptions,
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
