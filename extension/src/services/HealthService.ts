import * as NodeProcess from "node:process";
import { Data, Effect, Option, Schema } from "effect";
import { EXTENSION_PACKAGE } from "../utils/extension.ts";
import { Config } from "./Config.ts";
import { PythonLanguageServer } from "./completions/PythonLanguageServer.ts";
import { getUvVersion } from "./LanguageClient.ts";
import { PythonExtension } from "./PythonExtension.ts";
import { Uv, UvBin } from "./Uv.ts";
import { VsCode } from "./VsCode.ts";

export class CouldNotGetInformationError extends Data.TaggedError(
  "CouldNotGetInformationError",
)<{
  cause: unknown;
}> {}

/**
 * Provides health check and diagnostic information for the marimo extension.
 */
export class HealthService extends Effect.Service<HealthService>()(
  "HealthService",
  {
    dependencies: [Uv.Default, PythonLanguageServer.Default],
    effect: Effect.gen(function* () {
      const uv = yield* Uv;
      const code = yield* VsCode;
      const config = yield* Config;
      const pyExt = yield* PythonExtension;
      const pyLsp = yield* PythonLanguageServer;

      const getLspStatus = () =>
        Effect.try({
          // TODO: maybe run a quick check to see if the server can start
          try: () => ({ isAvailable: true }),
          catch: (cause) => new CouldNotGetInformationError({ cause }),
        });

      const formatDiagnostics = Effect.gen(function* () {
        const [lspCustomPath, uvDisabled] = yield* Effect.all([
          config.lsp.executable,
          Effect.map(config.uv.enabled, (enabled) => !enabled),
        ]);
        const uvVersion = getUvVersion(uv.bin.executable);
        const vscodeVersion = code.version;
        const extensionVersion = yield* getExtensionVersion(code).pipe(
          Effect.catchTag("CouldNotGetInformationError", () =>
            Effect.succeed("unknown"),
          ),
        );
        const lspStatus = yield* getLspStatus();

        const lines: string[] = [];

        // Header
        lines.push("marimo VS Code Extension Diagnostics");
        lines.push("=====================================");
        lines.push("");

        // LSP Status
        lines.push("Language Server (LSP):");

        UvBin.$match(uv.bin, {
          Default: (bin) => lines.push(`\tUV Bin: Default (${bin.executable})`),
          Configured: (bin) =>
            lines.push(`\tUV Bin: Configured (${bin.executable})`),
          Discovered: (bin) =>
            lines.push(`\tUV Bin: Discovered (${bin.executable})`),
        });

        if (Option.isSome(uvVersion)) {
          lines.push(`\tUV: ${uvVersion.value} ✓`);
        } else {
          lines.push("\tUV: Not found ✗");
        }

        if (Option.isSome(lspCustomPath)) {
          const { command, args = [] } = lspCustomPath.value as {
            command: string;
            args?: string[];
          };
          lines.push(`\tCustom path: ${command} ${args.join(" ")} `);
        } else {
          lines.push("\tUsing bundled marimo-lsp via uvx");
        }

        lines.push("");

        // Python Extension Environment
        lines.push("Python Extension:");
        const pyEnvPath = yield* pyExt
          .getActiveEnvironmentPath()
          .pipe(Effect.option);
        if (Option.isNone(pyEnvPath)) {
          lines.push("\tNot available (Python extension not found)");
        } else {
          const resolved = yield* pyExt
            .resolveEnvironment(pyEnvPath.value)
            .pipe(Effect.option);
          const env = Option.flatten(resolved);
          if (Option.isNone(env)) {
            lines.push(`\tInterpreter: ${pyEnvPath.value}`);
            lines.push("\tVersion: Unknown");
          } else {
            const e = env.value;
            lines.push(
              `\tInterpreter: ${e.executable.uri?.fsPath ?? e.path ?? "Unknown"}`,
            );
            lines.push(`\tVersion: ${e.version?.sysVersion ?? "Unknown"}`);
            if (e.environment) {
              lines.push(
                `\tEnvironment: ${e.environment.type} (${e.environment.name})`,
              );
            }
          }
        }

        lines.push("");

        // Python Language Server (ty) - only show if managed language features enabled
        const managedLanguageFeaturesEnabled =
          yield* config.getManagedLanguageFeaturesEnabled();
        if (managedLanguageFeaturesEnabled) {
          lines.push("Python Language Server (ty):");
          const tyHealth = yield* pyLsp.getHealthStatus.pipe(Effect.option);
          if (Option.isNone(tyHealth)) {
            lines.push("\tStatus: Not available");
          } else {
            const health = tyHealth.value;
            const statusIcon = health.status === "running" ? "✓" : "✗";
            lines.push(`\tStatus: ${health.status} ${statusIcon}`);
            if (health.version) {
              lines.push(`\tVersion: ${health.version}`);
            }
            if (health.pythonEnvironment) {
              const pyPath = health.pythonEnvironment.path ?? "Unknown";
              const pyVersion = health.pythonEnvironment.version
                ? ` (${health.pythonEnvironment.version})`
                : "";
              lines.push(`\tPython: ${pyPath}${pyVersion}`);
            }
            if (health.error) {
              lines.push(`\tError: ${health.error}`);
            }
          }

          lines.push("");
        }

        // Extension Configuration
        lines.push("Extension Configuration:");
        lines.push(`\tVersion: ${extensionVersion} `);
        lines.push(`\tUV integration disabled: ${uvDisabled} `);

        lines.push("");

        // System Information
        lines.push("System Information:");
        lines.push(`\tHost: ${code.env.appHost} `);
        lines.push(`\tIDE: ${code.env.appName} `);
        lines.push(`\tIDE version: ${vscodeVersion} `);
        lines.push(`\tPlatform: ${NodeProcess.platform} `);
        lines.push(`\tArchitecture: ${NodeProcess.arch} `);
        lines.push(`\tNode version: ${NodeProcess.version} `);
        lines.push("");

        if (UvBin.$is("Default")(uv.bin)) {
          // If using default UV (i.e., "uv"), show PATH for debugging

          // PATH (formatted for readability)
          lines.push("PATH:");
          const pathValue = NodeProcess.env.PATH;
          if (pathValue) {
            const separator = NodeProcess.platform === "win32" ? ";" : ":";
            for (const entry of pathValue.split(separator)) {
              lines.push(`\t${entry} `);
            }
          } else {
            lines.push("\t(not set)");
          }

          lines.push("");
        }

        // Troubleshooting
        if (!lspStatus.isAvailable) {
          lines.push("Troubleshooting:");
          lines.push("\t1. Check the 'marimo-lsp' output channel for errors");
          lines.push("\t2. Ensure uv is installed: https://docs.astral.sh/uv/");
          lines.push("\t3. Try reloading the VS Code window");
        } else {
          lines.push("Common Issues:");
          lines.push("\t1. If notebooks won't open:");
          lines.push("\t\t- Check Python interpreter is selected");
          lines.push("\t\t- Ensure marimo and pyzmq are installed");
          lines.push("\t\t- Check 'marimo-lsp' output channel for errors");
          lines.push("\t2. If features are missing:");
          lines.push("\t\t- Ensure marimo version is >= 0.17.0");
          lines.push("\t\t- Try reloading the window");
        }

        return lines.join("\n");
      });

      return {
        /**
         * Shows a text document with comprehensive diagnostics about the extension
         * and environment setup.
         */
        showDiagnostics: Effect.gen(function* () {
          yield* Effect.logInfo("Showing diagnostics");

          const diagnosticText = yield* formatDiagnostics.pipe(
            Effect.catchAll((error) =>
              Effect.succeed(
                `Error generating diagnostics: \n\n${String(error)} `,
              ),
            ),
          );

          const doc = yield* code.workspace.openUntitledTextDocument({
            content: diagnosticText,
            language: "plaintext",
          });

          yield* code.window.showTextDocument(doc);

          return doc;
        }),
      };
    }),
  },
) {}

export function getExtensionVersion(code: VsCode) {
  return Effect.gen(function* () {
    const ext = yield* code.extensions.getExtension(EXTENSION_PACKAGE.fullName);
    const pkg = yield* Schema.decodeUnknown(
      Schema.Struct({ version: Schema.String }),
    )(ext.packageJSON).pipe(
      Effect.mapError((cause) => new CouldNotGetInformationError({ cause })),
    );
    return pkg.version;
  }).pipe(
    Effect.catchTag("NoSuchElementException", () => Effect.succeed("unknown")),
  );
}
