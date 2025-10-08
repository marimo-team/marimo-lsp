import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
} from "../../../__mocks__/TestVsCode.ts";
import type { MarimoConfig, NotebookUri } from "../../../types.ts";
import { LanguageClient } from "../../LanguageClient.ts";
import { NotebookEditorRegistry } from "../../NotebookEditorRegistry.ts";
import { VsCode } from "../../VsCode.ts";
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
  options: { configStore?: Map<NotebookUri, MarimoConfig> } = {},
) {
  const vscode = yield* TestVsCode.make();
  const { configStore = new Map<NotebookUri, MarimoConfig>() } = options;

  const layer = MarimoConfigurationService.Default.pipe(
    Layer.provide(NotebookEditorRegistry.Default),
    Layer.provide(
      Layer.succeed(
        LanguageClient,
        LanguageClient.make({
          manage: () => Effect.scope,
          streamOf: () => Stream.never,
          executeCommand: Effect.fnUntraced(function* (cmd) {
            if (cmd.command === "marimo.get_configuration") {
              const config = configStore.get(cmd.params.notebookUri);
              if (config === undefined) {
                return yield* Effect.die(
                  `Config not found for ${cmd.params.notebookUri}`,
                );
              }
              return { config };
            }

            if (cmd.command === "marimo.update_configuration") {
              const existing = configStore.get(cmd.params.notebookUri);
              if (existing === undefined) {
                return yield* Effect.die(
                  `Config not found for ${cmd.params.notebookUri}`,
                );
              }
              const config = { ...existing, ...cmd.params.inner.config };
              configStore.set(cmd.params.notebookUri, config);
              return { config };
            }

            return yield* Effect.die(`Unknown command: ${cmd.command}`);
          }),
        }),
      ),
    ),
    Layer.provideMerge(vscode.layer),
  );

  return {
    vscode,
    layer,
    setConfig(uri: NotebookUri, config: MarimoConfig) {
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

  it.effect.skip(
    "should stream configuration changes",
    Effect.fnUntraced(function* () {
      const notebookUri = NOTEBOOK_URI;
      const initialConfig = AUTORUN_CONFIG;

      const ctx = yield* withTestCtx({
        configStore: new Map([[notebookUri, initialConfig]]),
      });

      const result = yield* Effect.gen(function* () {
        const service = yield* MarimoConfigurationService;

        // Test that streamConfigChanges is available and returns a stream
        const lastMessage = {
          runtime: { on_cell_change: "lazy" },
        };

        const collectedStreamed = service.streamActiveConfigChanges().pipe(
          Stream.takeUntil((value) =>
            Option.isSome(value) ? value.value === lastMessage : false,
          ),
          Stream.runCollect,
        );

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
        yield* service.updateConfig(notebookUri, lastMessage);

        // Collect the stream
        return yield* collectedStreamed;
      }).pipe(Effect.provide(ctx.layer));

      expect(result).toMatchInlineSnapshot();
    }),
  );

  it.effect(
    "should stream active notebook configuration changes",
    Effect.fnUntraced(function* () {
      const notebook1Uri = NOTEBOOK_URI_1;
      const notebook2Uri = NOTEBOOK_URI_2;

      const config1 = AUTORUN_CONFIG;
      const config2 = AUTORUN_CONFIG;

      const ctx = yield* withTestCtx({
        configStore: new Map([
          [notebook1Uri, config1],
          [notebook2Uri, config2],
        ]),
      });

      const result = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const service = yield* MarimoConfigurationService;

        // Test that streamActiveConfigChanges is available
        const stream = service.streamActiveConfigChanges();

        // Create notebook documents and editors
        const doc1 = createTestNotebookDocument(
          code.Uri.parse(notebook1Uri, true),
        );
        const doc2 = createTestNotebookDocument(
          code.Uri.parse(notebook2Uri, true),
        );
        const editor1 = createTestNotebookEditor(doc1);
        const editor2 = createTestNotebookEditor(doc2);

        // Change active notebook and verify state changes
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor1));
        yield* service.getConfig(notebook1Uri);
        const cached1 = yield* service.getCachedConfig(notebook1Uri);

        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor2));
        yield* service.getConfig(notebook2Uri);
        const cached2 = yield* service.getCachedConfig(notebook2Uri);

        return { stream, cached1, cached2 };
      }).pipe(Effect.provide(ctx.layer));

      expect(result.stream).toBeDefined();
      expect(Option.isSome(result.cached1)).toBe(true);
      expect(Option.getOrThrow(result.cached1).runtime?.on_cell_change).toBe(
        "autorun",
      );
      expect(Option.isSome(result.cached2)).toBe(true);
      expect(Option.getOrThrow(result.cached2).runtime?.on_cell_change).toBe(
        "autorun",
      );
    }),
  );

  it.effect(
    "should stream mapped configuration values",
    Effect.fnUntraced(function* () {
      const notebookUri = NOTEBOOK_URI;
      const mockConfig = AUTORUN_CONFIG;

      const ctx = yield* withTestCtx({
        configStore: new Map([[notebookUri, mockConfig]]),
      });

      const result = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const service = yield* MarimoConfigurationService;

        // Test that streamOf is available and can map config
        const stream = service.streamOf(
          (config) => config.runtime?.on_cell_change,
        );

        // Create notebook document and editor, set active
        const doc = createTestNotebookDocument(
          code.Uri.parse(notebookUri, true),
        );
        const editor = createTestNotebookEditor(doc);
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));

        // Fetch config
        const config = yield* service.getConfig(notebookUri);

        return { stream, config };
      }).pipe(Effect.provide(ctx.layer));

      expect(result.stream).toBeDefined();
      expect(result.config.runtime?.on_cell_change).toBe("autorun");
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

      const result = yield* Effect.gen(function* () {
        const service = yield* MarimoConfigurationService;

        // Fetch both
        const fetchedConfig1 = yield* service.getConfig(notebook1Uri);
        const fetchedConfig2 = yield* service.getConfig(notebook2Uri);

        // Update one
        yield* service.updateConfig(notebook1Uri, {
          runtime: {
            on_cell_change: "lazy",
          },
        });

        // Verify both are independent
        const cached1 = yield* service.getCachedConfig(notebook1Uri);
        const cached2 = yield* service.getCachedConfig(notebook2Uri);

        return { fetchedConfig1, fetchedConfig2, cached1, cached2 };
      }).pipe(Effect.provide(ctx.layer));

      expect(result.fetchedConfig1.runtime?.on_cell_change).toBe("autorun");
      expect(result.fetchedConfig2.runtime?.on_cell_change).toBe("lazy");
      expect(Option.isSome(result.cached1)).toBe(true);
      expect(Option.isSome(result.cached2)).toBe(true);
      expect(Option.getOrThrow(result.cached1).runtime?.on_cell_change).toBe(
        "lazy",
      );
      expect(Option.getOrThrow(result.cached2).runtime?.on_cell_change).toBe(
        "lazy",
      );
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
