import { Effect, Option } from "effect";
import type * as vscode from "vscode";

import { DEFAULT_NOTEBOOK_FILE_ROOT } from "../kernel/NotebookFileRoot.ts";
import { VsCode } from "../platform/VsCode.ts";

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
      return {
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
          executable: Effect.succeed(Option.none()),
        },
        notebookFileRoot() {
          return Effect.succeed(DEFAULT_NOTEBOOK_FILE_ROOT);
        },
        getManagedLanguageFeaturesEnabled() {
          return Effect.succeed(false);
        },
      };
    }

    return {
      uv: {
        get path() {
          return Effect.map(
            code.value.workspace.getConfiguration("marimo.uv"),
            (config) =>
              Option.fromNullable(config.get<string>("path")).pipe(
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
              Option.fromNullable(config.get<string>("path")).pipe(
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
              Option.fromNullable(config.get<string>("path")).pipe(
                Option.filter((p) => p.length > 0),
              ),
          );
        },
      },
      lsp: {
        get executable() {
          return Effect.gen(function* () {
            const config =
              yield* code.value.workspace.getConfiguration("marimo.lsp");
            return Option.fromNullable(config.get<string[]>("path")).pipe(
              Option.filter((path) => path.length > 0),
              Option.map(([command, ...args]) => ({
                command,
                args,
              })),
            );
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
  }),
}) {}
