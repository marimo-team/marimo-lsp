import { Effect } from "effect";

// biome-ignore lint: OK because this needs to get setup before everything else
import * as vscode from "vscode";

export class OutputChannel extends Effect.Service<OutputChannel>()(
  "OutputChannel",
  {
    scoped: Effect.acquireRelease(
      Effect.sync(() =>
        vscode.window.createOutputChannel("marimo", { log: true }),
      ),
      (disposable) => Effect.sync(() => disposable.dispose()),
    ),
  },
) {}
