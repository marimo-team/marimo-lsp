import { Context, Effect, Layer } from "effect";
import { VsCode } from "./VsCode.ts";

/**
 * Detects if the extension is running in Positron (Posit's data science IDE).
 *
 * Positron is a fork of VS Code with enhanced data science features.
 * We need to detect it to work around compatibility issues with its
 * notebook handler that intercepts .py files.
 */
export class PositronDetection extends Context.Tag("PositronDetection")<
  PositronDetection,
  {
    readonly isPositron: boolean;
    readonly version: string | undefined;
  }
>() {
  static readonly Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const vscode = yield* VsCode;

      // Positron can be detected by:
      // 1. The presence of positron-specific extensions
      // 2. The app name containing "Positron"
      const positronExtension = vscode.extensions.getExtension(
        "positron.positron",
      );
      const isPositronByName = vscode.env.appName
        .toLowerCase()
        .includes("positron");

      const isPositron = positronExtension !== undefined || isPositronByName;
      const version = positronExtension?.packageJSON?.version;

      yield* Effect.logInfo("Environment detection", {
        isPositron,
        appName: vscode.env.appName,
        positronVersion: version ?? "unknown",
      });

      return {
        isPositron,
        version,
      };
    }),
  );
}
