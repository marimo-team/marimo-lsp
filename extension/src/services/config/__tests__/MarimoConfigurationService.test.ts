import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream, TestClock } from "effect";
import { TestTelemetry } from "../../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
} from "../../../__mocks__/TestVsCode.ts";
import type { NotebookId } from "../../../schemas.ts";
import type { MarimoConfig } from "../../../types.ts";
import { LanguageClient } from "../../LanguageClient.ts";
import { NotebookEditorRegistry } from "../../NotebookEditorRegistry.ts";
import { VsCode } from "../../VsCode.ts";
import { MarimoConfigurationService } from "../MarimoConfigurationService.ts";

const NOTEBOOK_URI = "file:///test/notebook.py" as NotebookId;
const NOTEBOOK_URI_1 = "file:///test/notebook1.py" as NotebookId;
const NOTEBOOK_URI_2 = "file:///test/notebook2.py" as NotebookId;

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
  options: { configStore?: Map<NotebookId, MarimoConfig> } = {},
) {
  const vscode = yield* TestVsCode.make();
  const { configStore = new Map<NotebookId, MarimoConfig>() } = options;

  const layer = MarimoConfigurationService.Default.pipe(
    Layer.provide(NotebookEditorRegistry.Default),
    Layer.provide(
      Layer.succeed(
        LanguageClient,
        LanguageClient.make({
          channel: {
            name: "marimo-lsp",
            show() {},
          },
          restart: Effect.void,
          streamOf: () => Stream.never,
          executeCommand: Effect.fnUntraced(function* ({ command, params }) {
            if (!(command === "marimo.api")) {
              return yield* Effect.die(`Unknown command: ${command}`);
            }

            if (params.method === "get_configuration") {
              const config = configStore.get(params.params.notebookUri);
              if (config === undefined) {
                return yield* Effect.die(
                  `Config not found for ${params.params.notebookUri}`,
                );
              }
              return { config };
            }

            if (params.method === "update_configuration") {
              const existing = configStore.get(params.params.notebookUri);
              if (existing === undefined) {
                return yield* Effect.die(
                  `Config not found for ${params.params.notebookUri}`,
                );
              }
              const config = {
                ...existing,
                ...params.params.inner.config,
              };
              configStore.set(params.params.notebookUri, config);
              return { config };
            }

            return yield* Effect.die(
              `Unexpected marimo.api method: ${params.method}`,
            );
          }),
        }),
      ),
    ),
    Layer.provide(TestTelemetry),
    Layer.provideMerge(vscode.layer),
  );

  return {
    vscode,
    layer,
    setConfig(uri: NotebookId, config: MarimoConfig) {
      configStore.set(uri, config);
      return Effect.void;
    },
  };
});

describe("MarimoConfigurationService", () => {
  it.effect(
    "should build",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();
      const service = yield* Effect.provide(
        MarimoConfigurationService,
        ctx.layer,
      );
      expect(service).toBeDefined();
    }),
  );

  it.effect(
    "should fetch configuration from the language server",
    Effect.fnUntraced(function* () {
      const mockConfig = AUTORUN_CONFIG;
      const notebookUri = NOTEBOOK_URI;

      const ctx = yield* withTestCtx({
        configStore: new Map([[notebookUri, mockConfig]]),
      });

      const config = yield* Effect.gen(function* () {
        const service = yield* MarimoConfigurationService;
        return yield* service.getConfig(notebookUri);
      }).pipe(Effect.provide(ctx.layer));

      expect(config).toEqual(mockConfig);
    }),
  );

  it.effect(
    "should cache configuration after first fetch",
    Effect.fnUntraced(function* () {
      const notebookUri = NOTEBOOK_URI;
      const mockConfig = AUTORUN_CONFIG;
      const ctx = yield* withTestCtx({
        configStore: new Map([[notebookUri, mockConfig]]),
      });

      yield* Effect.gen(function* () {
        const service = yield* MarimoConfigurationService;

        // First fetch
        const config1 = yield* service.getConfig(notebookUri);
        expect(config1).toEqual(mockConfig);

        // Check cached config is available
        const cached = yield* service.getCachedConfig(notebookUri);
        expect(Option.isSome(cached)).toBe(true);
        expect(Option.getOrThrow(cached)).toEqual(mockConfig);

        // Clear the server-side config to verify cache is used
        yield* ctx.setConfig(notebookUri, {} as MarimoConfig);

        // Second fetch should return cached value
        const config2 = yield* service.getConfig(notebookUri);
        expect(config2).toEqual(mockConfig);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "should update configuration and cache",
    Effect.fnUntraced(function* () {
      const notebookUri = NOTEBOOK_URI;
      const initialConfig = AUTORUN_CONFIG;

      const ctx = yield* withTestCtx({
        configStore: new Map([[notebookUri, initialConfig]]),
      });

      const result = yield* Effect.gen(function* () {
        const service = yield* MarimoConfigurationService;

        // Update configuration
        const partialUpdate = { runtime: { on_cell_change: "lazy" } };
        const updatedConfig = yield* service.updateConfig(
          notebookUri,
          partialUpdate,
        );

        // Verify cache is updated
        const cached = yield* service.getCachedConfig(notebookUri);

        return { updatedConfig, cached };
      }).pipe(Effect.provide(ctx.layer));

      expect(result.updatedConfig.runtime?.on_cell_change).toBe("lazy");
      expect(Option.isSome(result.cached)).toBe(true);
      expect(Option.getOrThrow(result.cached).runtime?.on_cell_change).toBe(
        "lazy",
      );
    }),
  );

  it.effect(
    "should clear notebook configuration",
    Effect.fnUntraced(function* () {
      const notebookUri = NOTEBOOK_URI;
      const mockConfig = AUTORUN_CONFIG;

      const ctx = yield* withTestCtx({
        configStore: new Map([[notebookUri, mockConfig]]),
      });

      const result = yield* Effect.gen(function* () {
        const service = yield* MarimoConfigurationService;

        // Fetch and cache
        yield* service.getConfig(notebookUri);

        // Verify cached
        const cached1 = yield* service.getCachedConfig(notebookUri);

        // Clear
        yield* service.clearNotebook(notebookUri);

        // Verify cleared
        const cached2 = yield* service.getCachedConfig(notebookUri);

        return { cached1, cached2 };
      }).pipe(Effect.provide(ctx.layer));

      expect(Option.isSome(result.cached1)).toBe(true);
      expect(Option.isNone(result.cached2)).toBe(true);
    }),
  );

  it.effect(
    "should stream configuration changes and dedupe",
    Effect.fnUntraced(function* () {
      const notebookUri = NOTEBOOK_URI;
      const initialConfig = AUTORUN_CONFIG;

      const ctx = yield* withTestCtx({
        configStore: new Map([[notebookUri, initialConfig]]),
      });

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const service = yield* MarimoConfigurationService;

        const doc = createTestNotebookDocument(
          code.Uri.parse(notebookUri, true),
        );
        yield* ctx.vscode.addNotebookDocument(doc);
        yield* ctx.vscode.setActiveNotebookEditor(
          Option.some(createTestNotebookEditor(doc)),
        );
        yield* TestClock.adjust("10 millis");

        // Test that streamConfigChanges is available and returns a stream
        const stream = service.streamOf(
          (config) => config.runtime?.on_cell_change,
        );

        const collectedStreamed = yield* Effect.fork(
          stream.pipe(Stream.take(4), Stream.runCollect),
        );

        yield* TestClock.adjust("10 millis");

        // Trigger some changes
        // lazy, lazy, autorun, lazy, lazy
        yield* service.updateConfig(notebookUri, {
          runtime: { on_cell_change: "lazy" },
        });
        yield* service.updateConfig(notebookUri, {
          runtime: { on_cell_change: "lazy" },
        });
        yield* service.updateConfig(notebookUri, {
          runtime: { on_cell_change: "autorun" },
        });
        yield* service.updateConfig(notebookUri, {
          runtime: { on_cell_change: "lazy" },
        });
        yield* service.updateConfig(notebookUri, {
          runtime: { on_cell_change: "lazy" },
        });

        yield* TestClock.adjust("10 millis");

        // Collect the stream

        // Verify the stream contains the correct changes
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
              "value": "lazy",
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
          ],
        }
      `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "should stream configuration changes when active notebook changes",
    Effect.fnUntraced(function* () {
      const notebook1Uri = NOTEBOOK_URI_1;
      const notebook2Uri = NOTEBOOK_URI_2;

      const config1 = AUTORUN_CONFIG;
      const config2 = LAZY_CONFIG;

      const ctx = yield* withTestCtx({
        configStore: new Map([
          [notebook1Uri, config1],
          [notebook2Uri, config2],
        ]),
      });

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const service = yield* MarimoConfigurationService;

        const doc = createTestNotebookDocument(
          code.Uri.parse(notebook1Uri, true),
        );
        const doc2 = createTestNotebookDocument(
          code.Uri.parse(notebook2Uri, true),
        );

        // Add to workspace
        yield* ctx.vscode.addNotebookDocument(doc);
        yield* ctx.vscode.addNotebookDocument(doc2);

        // Test that streamActiveConfigChanges is available
        const stream = service.streamOf(
          (config) => config.runtime?.on_cell_change,
        );

        const collectedStreamed = yield* Effect.fork(
          stream.pipe(Stream.take(5), Stream.runCollect),
        );

        yield* TestClock.adjust("10 millis");

        // Change active notebook and verify state changes
        yield* ctx.vscode.setActiveNotebookEditor(
          Option.some(createTestNotebookEditor(doc)),
        );
        yield* TestClock.adjust("10 millis");

        yield* service.getConfig(notebook1Uri);
        yield* TestClock.adjust("10 millis");

        const cached1 = yield* service.getCachedConfig(notebook1Uri);
        expect(Option.isSome(cached1)).toBe(true);
        expect(Option.getOrThrow(cached1).runtime?.on_cell_change).toBe(
          "autorun",
        );

        yield* ctx.vscode.setActiveNotebookEditor(
          Option.some(createTestNotebookEditor(doc2)),
        );
        yield* TestClock.adjust("10 millis");

        yield* service.getConfig(notebook2Uri);
        yield* TestClock.adjust("10 millis");

        const cached2 = yield* service.getCachedConfig(notebook2Uri);
        expect(Option.isSome(cached2)).toBe(true);
        expect(Option.getOrThrow(cached2).runtime?.on_cell_change).toBe("lazy");
        yield* service.updateConfig(notebook2Uri, AUTORUN_CONFIG);
        yield* TestClock.adjust("10 millis");

        // Get it again
        const cached3 = yield* service.getConfig(notebook2Uri);
        expect(cached3.runtime?.on_cell_change).toBe("autorun");
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
              "_tag": "None",
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
    "should stream mapped configuration values",
    Effect.fnUntraced(function* () {
      const notebookUri = NOTEBOOK_URI;
      const mockConfig = AUTORUN_CONFIG;
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const service = yield* MarimoConfigurationService;

        const doc = createTestNotebookDocument(
          code.Uri.parse(notebookUri, true),
        );
        yield* ctx.vscode.addNotebookDocument(doc);
        yield* TestClock.adjust("10 millis");

        // Test that streamOf is available and can map config
        const stream = service.streamOf(
          (config) => config.runtime?.on_cell_change,
        );

        const collectedStreamed = yield* Effect.fork(
          stream.pipe(Stream.take(2), Stream.runCollect),
        );

        yield* TestClock.adjust("10 millis");

        yield* ctx.setConfig(notebookUri, mockConfig);

        // Set active and fetch
        yield* ctx.vscode.setActiveNotebookEditor(
          Option.some(createTestNotebookEditor(doc)),
        );
        const config = yield* service.getConfig(notebookUri);

        // Verify mapping would work on the config
        expect(config.runtime?.on_cell_change).toBe("autorun");

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
          ],
        }
      `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "should handle multiple notebooks independently",
    Effect.fnUntraced(function* () {
      const notebook1Uri = NOTEBOOK_URI_1;
      const notebook2Uri = NOTEBOOK_URI_2;

      const config1 = AUTORUN_CONFIG;
      const config2 = LAZY_CONFIG;

      const ctx = yield* withTestCtx({
        configStore: new Map([
          [notebook1Uri, config1],
          [notebook2Uri, config2],
        ]),
      });

      const { cached1, cached2 } = yield* Effect.gen(function* () {
        const service = yield* MarimoConfigurationService;

        // Fetch both
        const fetchedConfig1 = yield* service.getConfig(notebook1Uri);
        const fetchedConfig2 = yield* service.getConfig(notebook2Uri);

        expect(fetchedConfig1.runtime?.on_cell_change).toBe("autorun");
        expect(fetchedConfig2.runtime?.on_cell_change).toBe("lazy");

        // Update one
        yield* service.updateConfig(notebook1Uri, {
          runtime: {
            on_cell_change: "lazy",
          },
        });

        // Verify both are independent
        const cached1 = yield* service.getCachedConfig(notebook1Uri);
        const cached2 = yield* service.getCachedConfig(notebook2Uri);

        return { cached1, cached2 };
      }).pipe(Effect.provide(ctx.layer));

      expect(Option.isSome(cached1)).toBe(true);
      expect(Option.isSome(cached2)).toBe(true);
      expect(Option.getOrThrow(cached1).runtime?.on_cell_change).toBe("lazy");
      expect(Option.getOrThrow(cached2).runtime?.on_cell_change).toBe("lazy");
    }),
  );

  it.effect(
    "should return cached config when available without LSP call",
    Effect.fnUntraced(function* () {
      const notebookUri = NOTEBOOK_URI;
      const mockConfig = AUTORUN_CONFIG;

      const ctx = yield* withTestCtx({
        configStore: new Map([[notebookUri, mockConfig]]),
      });

      const cached = yield* Effect.gen(function* () {
        const service = yield* MarimoConfigurationService;

        // Initial fetch
        yield* service.getConfig(notebookUri);

        // Verify getCachedConfig returns immediately
        return yield* service.getCachedConfig(notebookUri);
      }).pipe(Effect.provide(ctx.layer));

      expect(Option.isSome(cached)).toBe(true);
      expect(Option.getOrThrow(cached).runtime?.on_cell_change).toBe("autorun");
    }),
  );
});
