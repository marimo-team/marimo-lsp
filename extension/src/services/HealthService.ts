import * as NodeProcess from "node:process";
import { Data, Effect, Option, pipe, Schema } from "effect";
import { EXTENSION_PACKAGE } from "../utils/extension.ts";
import { Config } from "./Config.ts";
import { isUvInstalled } from "./LanguageClient.ts";
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
    effect: Effect.gen(function* () {
      const code = yield* VsCode;
      const config = yield* Config;

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
        const vscodeVersion = code.version;
        const extensionVersion = yield* getExtensionVersion(code);
        const lspStatus = yield* getLspStatus();

        const lines: string[] = [];

        // Header
        lines.push("marimo VS Code Extension Diagnostics");
        lines.push("=====================================");
        lines.push("");

        // LSP Status
        lines.push("Language Server (LSP):");
        lines.push(`\tUV installed: ${isUvInstalled() ? "Yes ✓" : "No ✗"}`);

        if (Option.isSome(lspCustomPath)) {
          const { command, args = [] } = lspCustomPath.value as {
            command: string;
            args?: string[];
          };
          lines.push(`\tCustom path: ${command} ${args.join(" ")}`);
        } else {
          lines.push("\tUsing bundled marimo-lsp via uvx");
        }

        lines.push("");

        // Extension Configuration
        lines.push("Extension Configuration:");
        lines.push(`\tVersion: ${extensionVersion}`);
        lines.push(`\tUV integration disabled: ${uvDisabled}`);

        lines.push("");

        // System Information
        lines.push("System Information:");
        lines.push(`\tVS Code version: ${vscodeVersion}`);
        lines.push(`\tPlatform: ${NodeProcess.platform}`);
        lines.push(`\tArchitecture: ${NodeProcess.arch}`);
        lines.push(`\tNode version: ${NodeProcess.version}`);

        lines.push("");

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
                `Error generating diagnostics:\n\n${String(error)}`,
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

export const getExtensionVersion = Effect.fnUntraced(function* (code: VsCode) {
  return code.extensions.getExtension(EXTENSION_PACKAGE.fullName).pipe(
    // Try parsing metadata if it's there
    Option.map((ext) =>
      pipe(
        ext.packageJSON,
        Schema.decodeUnknown(Schema.Struct({ version: Schema.String })),
        Effect.map((pkg) => pkg.version),
        Effect.mapError((cause) => new CouldNotGetInformationError({ cause })),
      ),
    ),
    // Otherwise fallback to unknown
    Option.getOrElse(() => Effect.succeed("unknown")),
  );
});
