import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { Data, Effect, Option, pipe } from "effect";
import * as lsp from "vscode-languageclient/node";
import type { ClientNotebookSync } from "../services/completions/NotebookSyncService.ts";
import { ExtensionContext } from "../services/Storage.ts";
import { Uv } from "../services/Uv.ts";

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
class InternalNamespacedLanguageClient extends lsp.LanguageClient {
  #prefix: string;

  constructor(
    id: string,
    name: string,
    serverOptions: lsp.ServerOptions,
    clientOptions: lsp.LanguageClientOptions,
  ) {
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

export class LanguageClientError extends Data.TaggedError(
  "LanguageClientError",
)<{
  cause: unknown;
}> {
  formatMessage(): string {
    if (isLanguageServerError(this.cause)) {
      const code = this.cause.code;
      switch (code) {
        case -32097:
          return `Connection closed unexpectedly. The server process may have crashed or failed to start (code: ${code})`;
        default:
          return `Language server error (code: ${code})`;
      }
    }
    if (this.cause instanceof Error) {
      return this.cause.message;
    }
    return JSON.stringify(this.cause);
  }
}

function isLanguageServerError(x: unknown): x is { code: number } {
  return (
    typeof x === "object" &&
    x !== null &&
    "code" in x &&
    typeof x.code === "number"
  );
}

export type ManagedLanguageClient = Effect.Effect.Success<
  ReturnType<typeof createManagedLanguageClient>
>;

export const createManagedLanguageClient = Effect.fn(function* (
  server: {
    name: "ty" | "ruff";
    version: `${number}.${number}.${number}`;
  },
  options: {
    notebookSync: ClientNotebookSync;
    clientOptions: lsp.LanguageClientOptions;
  },
) {
  const uv = yield* Uv;
  const context = yield* ExtensionContext;

  const targetPath = NodePath.resolve(context.globalStorageUri.fsPath, "libs");

  yield* Effect.logInfo("Installing language server binary").pipe(
    Effect.annotateLogs({
      server: server.name,
      version: server.version,
      targetPath,
    }),
  );

  const binaryPath = yield* uv.ensureLanguageServerBinaryInstalled(server, {
    targetPath,
  });

  yield* Effect.logInfo("Language server binary installed").pipe(
    Effect.annotateLogs({
      server: server.name,
      version: server.version,
      binaryPath,
    }),
  );

  const serverOptions: lsp.ServerOptions = {
    command: binaryPath,
    args: ["server"],
    options: {
      env: { ...NodeProcess.env },
    },
  };

  const client = new InternalNamespacedLanguageClient(
    `marimo-${server.name}`,
    `marimo (${server.name})`,
    serverOptions,
    options.clientOptions,
  );

  yield* Effect.addFinalizer(() =>
    // NB: `dispose()` wraps `.stop()` internally.
    // `Infinity` bypasses VS Code timeout errors; Effect owns timeout + error handling.
    Effect.tryPromise(() => client.dispose(Infinity)).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTag("TimeoutException", "UnknownException", (error) =>
        Effect.logWarning("Language client dispose failed").pipe(
          Effect.annotateLogs({ error, server }),
        ),
      ),
    ),
  );

  const start = () =>
    pipe(
      Effect.tryPromise({
        try: () => client.start(),
        catch: (cause) => new LanguageClientError({ cause }),
      }),
      Effect.map(() =>
        Option.fromNullable(client.initializeResult?.serverInfo?.version).pipe(
          Option.map((version) => ({ version })),
        ),
      ),
    );

  const stop = () =>
    Effect.tryPromise({
      try: () => client.stop(Infinity),
      catch: (cause) => new LanguageClientError({ cause }),
    });

  const restart = Effect.fn(function* (reason: string) {
    yield* Effect.logInfo(`Restarting ${server.name} language server`, reason);
    if (client.isRunning()) {
      yield* stop();
    }
    yield* start();
    yield* Effect.logInfo(`${server.name} language server restarted`);
  });

  // Connect to notebook sync service
  yield* options.notebookSync.connect(client);

  return {
    start,
    stop,
    restart,
    sendNotification(method: string, params: unknown) {
      return Effect.promise(() => client.sendNotification(method, params));
    },
  };
});
