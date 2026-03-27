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

const withTestCtx = Effect.fn(function* (
  initialTheme: "light" | "dark" = "light",
) {
  const themeRef = yield* SubscriptionRef.make<"light" | "dark">(initialTheme);
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
    Layer.provide(
      Layer.succeed(
        LanguageClient,
        LanguageClient.make({
          channel: { name: "marimo-lsp", show() {} },
          restart: () => Effect.void,
          executeCommand(cmd) {
            return Ref.update(executions, (arr) => [...arr, cmd]);
          },
          streamOf() {
            return Stream.never;
          },
        }),
      ),
    ),
    Layer.provide(TestTelemetryLive),
    Layer.provide(TestSentryLive),
    Layer.provide(vscode.layer),
  );

  return {
    layer,
    vscode,
    editor,
    themeRef,
    executions,
  };
});

describe("ThemeSync", () => {
  it.scoped(
    "sends set-display-theme on theme change",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx("light");

      yield* Effect.gen(function* () {
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust("1 millis");

        yield* SubscriptionRef.set(ctx.themeRef, "dark");
        yield* TestClock.adjust("1 millis");

        expect(yield* ctx.executions).toMatchInlineSnapshot(`
          [
            {
              "command": "marimo.api",
              "params": {
                "method": "set-display-theme",
                "params": {
                  "theme": "light",
                },
              },
            },
            {
              "command": "marimo.api",
              "params": {
                "method": "set-display-theme",
                "params": {
                  "theme": "dark",
                },
              },
            },
          ]
        `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "syncs theme when a new notebook becomes active",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx("dark");

      yield* Effect.gen(function* () {
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust("1 millis");

        expect(yield* ctx.executions).toMatchInlineSnapshot(`
          [
            {
              "command": "marimo.api",
              "params": {
                "method": "set-display-theme",
                "params": {
                  "theme": "dark",
                },
              },
            },
          ]
        `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
