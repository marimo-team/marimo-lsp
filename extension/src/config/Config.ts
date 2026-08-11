import { Data, Effect, Option, Schema } from "effect";
import type * as vscode from "vscode";

import { DEFAULT_NOTEBOOK_FILE_ROOT } from "../kernel/NotebookFileRoot.ts";
import { VsCode } from "../platform/VsCode.ts";

const MarimoLspServerSetting = Schema.Literal("wasm", "python", "custom");
const MarimoLspCommand = Schema.NonEmptyArray(Schema.String).pipe(
  Schema.filter(([command]) => command.trim().length > 0, {
    message: () => "The marimo-lsp command must not be empty",
  }),
);

export type MarimoLspCommand = typeof MarimoLspCommand.Type;

export const MarimoLspServer = Data.taggedEnum<MarimoLspServer>();
export type MarimoLspServer = Data.TaggedEnum<{
  Wasm: {};
  Python: {};
  Custom: { readonly command: MarimoLspCommand };
}>;

export class InvalidMarimoLspConfiguration extends Data.TaggedError(
  "InvalidMarimoLspConfiguration",
)<{
  readonly setting: "marimo.lsp.path" | "marimo.lsp.server";
  readonly message: string;
  readonly cause: unknown;
}> {}

const decodeServerSetting = (value: unknown) =>
  Schema.decodeUnknown(MarimoLspServerSetting)(value).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidMarimoLspConfiguration({
          setting: "marimo.lsp.server",
          message:
            "Invalid marimo.lsp.server value. Choose wasm, python, or custom.",
          cause,
        }),
    ),
  );

const decodeCommand = (value: unknown) =>
  Schema.decodeUnknown(MarimoLspCommand)(value).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidMarimoLspConfiguration({
          setting: "marimo.lsp.path",
          message:
            "marimo.lsp.server is set to custom, but marimo.lsp.path does not contain a valid command.",
          cause,
        }),
    ),
  );

export const resolveMarimoLspServer = Effect.fn(
  "Config.resolveMarimoLspServer",
)(function* ({
  server,
  path,
}: {
  readonly server: unknown;
  readonly path: unknown;
}) {
  const configured = yield* decodeServerSetting(
    server === undefined ? "wasm" : server,
  );
  switch (configured) {
    case "wasm":
      return MarimoLspServer.Wasm();
    case "python":
      return MarimoLspServer.Python();
    case "custom":
      return MarimoLspServer.Custom({
        command: yield* decodeCommand(path),
      });
    default: {
      const exhaustive: never = configured;
      return exhaustive;
    }
  }
});

interface ConfigService {
  readonly uv: {
    readonly path: Effect.Effect<Option.Option<string>>;
    readonly enabled: Effect.Effect<boolean>;
  };
  readonly ruff: {
    readonly path: Effect.Effect<Option.Option<string>>;
  };
  readonly ty: {
    readonly path: Effect.Effect<Option.Option<string>>;
  };
  readonly lsp: {
    readonly server: Effect.Effect<
      MarimoLspServer,
      InvalidMarimoLspConfiguration
    >;
  };
  readonly notebookFileRoot: (
    scope?: vscode.ConfigurationScope,
  ) => Effect.Effect<string>;
  readonly getManagedLanguageFeaturesEnabled: () => Effect.Effect<boolean>;
}

/**
 * Provides access to the extension configuration settings.
 */
export class Config extends Effect.Service<Config>()("Config", {
  effect: Effect.gen(function* () {
    const code = yield* Effect.serviceOption(VsCode);

    if (Option.isNone(code)) {
      yield* Effect.logWarning(
        "VsCode API is not available. Using default configuration values.",
      );
      const defaults: ConfigService = {
        uv: {
          path: Effect.succeed(Option.none<string>()),
          enabled: Effect.succeed(false),
        },
        ruff: {
          path: Effect.succeed(Option.none<string>()),
        },
        ty: {
          path: Effect.succeed(Option.none<string>()),
        },
        lsp: {
          server: Effect.succeed(MarimoLspServer.Wasm()),
        },
        notebookFileRoot() {
          return Effect.succeed(DEFAULT_NOTEBOOK_FILE_ROOT);
        },
        getManagedLanguageFeaturesEnabled() {
          return Effect.succeed(false);
        },
      };
      return defaults;
    }

    const configured: ConfigService = {
      uv: {
        get path() {
          return Effect.map(
            code.value.workspace.getConfiguration("marimo.uv"),
            (config) =>
              Option.fromNullishOr(config.get<string>("path")).pipe(
                Option.filter((p) => p.length > 0),
              ),
          );
        },
        get enabled() {
          return Effect.andThen(
            code.value.workspace.getConfiguration("marimo"),
            (config) => !config.get("disableUvIntegration", false),
          );
        },
      },
      ruff: {
        get path() {
          return Effect.map(
            code.value.workspace.getConfiguration("marimo.ruff"),
            (config) =>
              Option.fromNullishOr(config.get<string>("path")).pipe(
                Option.filter((p) => p.length > 0),
              ),
          );
        },
      },
      ty: {
        get path() {
          return Effect.map(
            code.value.workspace.getConfiguration("marimo.ty"),
            (config) =>
              Option.fromNullishOr(config.get<string>("path")).pipe(
                Option.filter((p) => p.length > 0),
              ),
          );
        },
      },
      lsp: {
        get server() {
          return Effect.gen(function* () {
            const lspConfig =
              yield* code.value.workspace.getConfiguration("marimo.lsp");
            return yield* resolveMarimoLspServer({
              server: lspConfig.get<unknown>("server"),
              path: lspConfig.get<unknown>("path") ?? [],
            });
          });
        },
      },
      notebookFileRoot(scope?: vscode.ConfigurationScope) {
        return Effect.map(
          code.value.workspace.getConfiguration("marimo", scope),
          (config) =>
            config.get<string>("notebookFileRoot") ??
            DEFAULT_NOTEBOOK_FILE_ROOT,
        );
      },
      getManagedLanguageFeaturesEnabled() {
        return Effect.andThen(
          code.value.workspace.getConfiguration("marimo"),
          (config) => !config.get("disableManagedLanguageFeatures", false),
        );
      },
    };
    return configured;
  }),
}) {}
