import { expect, it } from "@effect/vitest";
import { Effect, Layer, Chunk, Option, Ref, Stream, TestClock } from "effect";
import type * as vscode from "vscode";
import { TestVsCode } from "../../../__mocks__/TestVsCode.ts";
import type { MarimoConfig, NotebookUri } from "../../../types.ts";
import { LanguageClient } from "../../LanguageClient.ts";
import { NotebookEditorRegistry } from "../../NotebookEditorRegistry.ts";
import { ConfigContextManager } from "../ConfigContextManager.ts";
import { MarimoConfigurationService } from "../MarimoConfigurationService.ts";

const NOTEBOOK_URI = "file:///test/notebook.py" as NotebookUri;
const NOTEBOOK_URI_1 = "file:///test/notebook1.py" as NotebookUri;
const NOTEBOOK_URI_2 = "file:///test/notebook2.py" as NotebookUri;

const AUTORUN_CONFIG = {
  runtime: {
    on_cell_change: "autorun",
  },
} as MarimoConfig;

const LAZY_CONFIG = {
  runtime: {
    on_cell_change: "lazy",
  },
} as MarimoConfig;

const withTestCtx = Effect.fnUntraced(function* (
  options: {
    initialConfigStore?: Array<[NotebookUri, MarimoConfig]>;
    initialDocuments?: Array<vscode.NotebookDocument>;
  } = {},
) {
  const configStore = new Map(options.initialConfigStore ?? []);
  const vscode = yield* TestVsCode.make({
    initialDocuments: options.initialDocuments,
  });

  const layer = ConfigContextManager.Default.pipe(
    Layer.merge(MarimoConfigurationService.Default),
    Layer.provide(
      Layer.succeed(
        LanguageClient,
        LanguageClient.make({
          manage: () => Effect.scope,
          streamOf: () => Effect.never,
          executeCommand: Effect.fnUntraced(function* (cmd) {
            if (cmd.command === "marimo.get_configuration") {
              const config = configStore.get(cmd.params.notebookUri);
              if (!config) {
                return yield* Effect.die(
                  `Config not found for ${cmd.params.notebookUri}`,
                );
              }
              return { config };
            }

            if (cmd.command === "marimo.update_configuration") {
              const existing = configStore.get(cmd.params.notebookUri);
              if (!existing) {
                return yield* Effect.die(
                  `Config not found for ${cmd.params.notebookUri}`,
                );
              }
              const config = {
                ...existing,
                ...cmd.params.inner.config,
              };
              configStore.set(cmd.params.notebookUri, config);
              return { config };
            }

            return yield* Effect.die(`Unknown command: ${cmd.command}`);
          }),
        }),
      ),
    ),
    Layer.provide(NotebookEditorRegistry.Default),
    Layer.provideMerge(vscode.layer),
  );

  return { vscode, layer };
});

describe("ConfigContextManager", () => {
  it.scoped(
    "should update VSCode context when config changes",
    Effect.fnUntraced(function* () {
      const notebookUri = NOTEBOOK_URI;
      const editor = TestVsCode.makeNotebookEditor(notebookUri);
      const ctx = yield* withTestCtx({
        initialDocuments: [editor.notebook],
        initialConfigStore: [[notebookUri, AUTORUN_CONFIG]],
      });

      const calls = yield* Effect.gen(function* () {
        const configService = yield* MarimoConfigurationService;

        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("10 millis");

        // Fetch config to populate cache
        yield* configService.getConfig(notebookUri);
        yield* TestClock.adjust("10 millis");

        // Update to lazy
        yield* configService.updateConfig(notebookUri, LAZY_CONFIG);
        yield* TestClock.adjust("10 millis");

        return yield* Ref.get(ctx.vscode.executions);
      }).pipe(Effect.provide(ctx.layer));

      // Should have at least 2 calls: initial (autorun) and update (lazy)
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls.some((c) => c.args[1] === "autorun")).toBe(true);
      expect(calls.some((c) => c.args[1] === "lazy")).toBe(true);
    }),
  );

  it.effect(
    "should default to autorun when config is None",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();

      const calls = yield* Effect.gen(function* () {
        yield* TestClock.adjust("10 millis");

        // Initial context should be set to autorun (default)
        return yield* Ref.get(ctx.vscode.executions);
      }).pipe(Effect.provide(ctx.layer));

      // Initial context should be set to autorun (default)
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].args[0]).toBe("marimo.config.runtime.on_cell_change");
      expect(calls[0].args[1]).toBe("autorun");
    }),
  );

  it.scoped(
    "should stream on_cell_change mode changes",
    Effect.fnUntraced(function* () {
      const notebookUri = NOTEBOOK_URI;
      const editor = TestVsCode.makeNotebookEditor(notebookUri);

      const ctx = yield* withTestCtx({
        initialConfigStore: [[notebookUri, AUTORUN_CONFIG]],
        initialDocuments: [editor.notebook],
      });

      yield* ctx.vscode.setActiveNotebookEditor(Option.none());
      yield* TestClock.adjust("10 millis");

      yield* Effect.gen(function* () {
        const configService = yield* MarimoConfigurationService;
        const manager = yield* ConfigContextManager;

        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));

        const collectedStreamed = yield* Effect.fork(
          manager
            .streamOnCellChangeModeChanges()
            .pipe(Stream.take(1), Stream.runCollect),
        );

        // Fetch initial config
        yield* configService.getConfig(notebookUri);
        yield* TestClock.adjust("10 millis");

        // Make changes
        yield* configService.updateConfig(notebookUri, LAZY_CONFIG);
        yield* TestClock.adjust("10 millis");

        yield* configService.updateConfig(notebookUri, AUTORUN_CONFIG);
        yield* TestClock.adjust("10 millis");

        const collected = yield* collectedStreamed;
        expect(collected).toMatchInlineSnapshot(`
        {
          "_id": "Chunk",
          "values": [
            {
              "_id": "Option",
              "_tag": "None",
            },
            {
              "_id": "Option",
              "_tag": "Some",
              "value": "autorun",
            },
            {
              "_id": "Option",
              "_tag": "Some",
              "value": "lazy",
            },
            {
              "_id": "Option",
              "_tag": "Some",
              "value": "autorun",
            },
          ],
        }
      `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "should handle switching between notebooks",
    Effect.fnUntraced(function* () {
      const editor1 = TestVsCode.makeNotebookEditor(NOTEBOOK_URI_1);
      const editor2 = TestVsCode.makeNotebookEditor(NOTEBOOK_URI_2);
      const ctx = yield* withTestCtx({
        initialDocuments: [editor1.notebook, editor2.notebook],
        initialConfigStore: [
          [NOTEBOOK_URI_1, AUTORUN_CONFIG],
          [NOTEBOOK_URI_2, LAZY_CONFIG],
        ],
      });
      yield* Effect.gen(function* () {
        const configService = yield* MarimoConfigurationService;

        // Switch to notebook 1
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor1));
        yield* TestClock.adjust("10 millis");

        yield* configService.getConfig(NOTEBOOK_URI_1);
        yield* TestClock.adjust("10 millis");

        let calls = yield* Ref.get(ctx.vscode.executions);
        expect(calls[calls.length - 1].args[1]).toBe("autorun");

        // Switch to notebook 2
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor2));
        yield* TestClock.adjust("10 millis");

        yield* configService.getConfig(NOTEBOOK_URI_2);
        yield* TestClock.adjust("10 millis");

        calls = yield* Ref.get(ctx.vscode.executions);
        expect(calls[calls.length - 1].args[1]).toBe("lazy");
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
