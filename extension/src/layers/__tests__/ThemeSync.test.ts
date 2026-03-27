import { describe, expect, it } from "@effect/vitest";
import {
  Effect,
  Layer,
  Option,
  Ref,
  Stream,
  SubscriptionRef,
  TestClock,
} from "effect";

import { TestSentryLive } from "../../__mocks__/TestSentry.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { LanguageClient } from "../../services/LanguageClient.ts";
import { NotebookEditorRegistry } from "../../services/NotebookEditorRegistry.ts";
import type { MarimoCommand } from "../../types.ts";
import { ThemeSyncLive } from "../ThemeSync.ts";

function makeMockLanguageClient(
  executions: Ref.Ref<ReadonlyArray<MarimoCommand>>,
) {
  return Layer.succeed(
    LanguageClient,
    LanguageClient.make({
      channel: { name: "marimo-lsp", show() {} },
      restart: () => Effect.void,
      executeCommand(cmd) {
        return Ref.update(executions, (arr) => [...arr, cmd]);
      },
      streamOf() {
        return Stream.empty as never;
      },
    }),
  );
}

function themeCommands(cmds: ReadonlyArray<MarimoCommand>) {
  return cmds
    .filter(
      (c) =>
        c.command === "marimo.api" && c.params.method === "set-display-theme",
    )
    .map((c) => (c.params as { params: { theme: string } }).params);
}

describe("ThemeSync", () => {
  it.scoped(
    "sends set-display-theme on theme change",
    Effect.fn(function* () {
      const themeRef = yield* SubscriptionRef.make<"light" | "dark">("light");
      const executions = yield* Ref.make<ReadonlyArray<MarimoCommand>>([]);

      const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
        data: {
          cells: [
            {
              kind: 1,
              value: "import marimo as mo",
              languageId: "python",
              metadata: { stableId: "cell-1" },
            },
          ],
        },
      });

      const vscode = yield* TestVsCode.make({
        initialDocuments: [editor.notebook],
        window: {
          colorThemeChanges: () => themeRef.changes,
        },
      });

      const layer = Layer.empty.pipe(
        Layer.provideMerge(ThemeSyncLive),
        Layer.provide(NotebookEditorRegistry.Default),
        Layer.provide(makeMockLanguageClient(executions)),
        Layer.provide(TestTelemetryLive),
        Layer.provide(TestSentryLive),
        Layer.provide(vscode.layer),
      );

      yield* Effect.gen(function* () {
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("1 millis");

        // Change theme
        yield* SubscriptionRef.set(themeRef, "dark");
        yield* TestClock.adjust("1 millis");

        const cmds = themeCommands(yield* Ref.get(executions));
        const darkCmd = cmds.find((c) => c.theme === "dark");
        expect(darkCmd).toBeDefined();
      }).pipe(Effect.provide(layer));
    }),
  );

  it.scoped(
    "syncs theme when a new notebook becomes active",
    Effect.fn(function* () {
      const themeRef = yield* SubscriptionRef.make<"light" | "dark">("dark");
      const executions = yield* Ref.make<ReadonlyArray<MarimoCommand>>([]);

      const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
        data: {
          cells: [
            {
              kind: 1,
              value: "",
              languageId: "python",
              metadata: { stableId: "cell-1" },
            },
          ],
        },
      });

      const vscode = yield* TestVsCode.make({
        initialDocuments: [editor.notebook],
        window: {
          colorThemeChanges: () => themeRef.changes,
        },
      });

      const layer = Layer.empty.pipe(
        Layer.provideMerge(ThemeSyncLive),
        Layer.provide(NotebookEditorRegistry.Default),
        Layer.provide(makeMockLanguageClient(executions)),
        Layer.provide(TestTelemetryLive),
        Layer.provide(TestSentryLive),
        Layer.provide(vscode.layer),
      );

      yield* Effect.gen(function* () {
        // Activate the notebook — should trigger theme sync
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("1 millis");

        const cmds = themeCommands(yield* Ref.get(executions));
        const darkCmd = cmds.find((c) => c.theme === "dark");
        expect(darkCmd).toBeDefined();
      }).pipe(Effect.provide(layer));
    }),
  );
});
