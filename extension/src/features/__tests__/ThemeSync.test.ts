import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import {
  makeTestMarimoClient,
  type TestCommand,
} from "../../__tests__/__utils__/TestMarimoClient.ts";
import { NotebookEditorRegistry } from "../../notebook/NotebookEditorRegistry.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import { ThemeSyncLive } from "../ThemeSync.ts";

const withTestCtx = Effect.fn(function* (
  initialTheme: "light" | "dark" = "light",
) {
  const themeRef = yield* SubscriptionRef.make<"light" | "dark">(initialTheme);
  const executions = yield* Ref.make<ReadonlyArray<TestCommand>>([]);

  const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
    data: {
      cells: [
        {
          kind: 1,
          value: "",
          languageId: "python",
          metadata: MarimoNotebookCell.createMetadata({
            marimoRuntime: { stableId: "cell-1" },
          }),
        },
      ],
    },
  });

  const vscode = yield* TestVsCode.make({
    initialDocuments: [editor.notebook],
    window: {
      colorThemeChanges: SubscriptionRef.changes(themeRef),
    },
  });

  const layer = Layer.empty.pipe(
    Layer.provideMerge(ThemeSyncLive),
    Layer.provide(NotebookEditorRegistry.layer),
    Layer.provide(
      makeTestMarimoClient({
        send(request) {
          return Ref.update(executions, (current) => [
            ...current,
            request,
          ]).pipe(Effect.as({ success: true }));
        },
      }),
    ),
    Layer.provide(TestTelemetryLive),
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
  it.effect(
    "sends set-display-theme on theme change",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx("light");

      yield* Effect.gen(function* () {
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust("1 millis");

        yield* SubscriptionRef.set(ctx.themeRef, "dark");
        yield* TestClock.adjust("1 millis");

        expect(yield* Ref.get(ctx.executions)).toMatchInlineSnapshot(`
          [
            {
              "kind": "set-display-theme",
              "theme": "light",
            },
            {
              "kind": "set-display-theme",
              "theme": "light",
            },
            {
              "kind": "set-display-theme",
              "theme": "dark",
            },
          ]
        `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "sends set-display-theme while no marimo notebook is active",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx("light");

      yield* Effect.gen(function* () {
        // The focus is on a text editor. The registry has no notebook.
        yield* ctx.vscode.setActiveNotebookEditor(Option.none());
        yield* TestClock.adjust("1 millis");

        yield* SubscriptionRef.set(ctx.themeRef, "dark");
        yield* TestClock.adjust("1 millis");

        // set-display-theme updates all running sessions. The kernels must
        // get the change when no notebook is focused.
        expect(yield* Ref.get(ctx.executions)).toContainEqual({
          kind: "set-display-theme",
          theme: "dark",
        });
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "syncs theme when a new notebook becomes active",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx("dark");

      yield* Effect.gen(function* () {
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust("1 millis");

        expect(yield* Ref.get(ctx.executions)).toMatchInlineSnapshot(`
          [
            {
              "kind": "set-display-theme",
              "theme": "dark",
            },
            {
              "kind": "set-display-theme",
              "theme": "dark",
            },
          ]
        `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
