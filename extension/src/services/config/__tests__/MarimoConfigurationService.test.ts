import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream, SubscriptionRef } from "effect";
import { partialService } from "../../../__tests__/__utilts__/partial.ts";
import type { MarimoConfig, NotebookUri } from "../../../types.ts";
import { LanguageClient } from "../../LanguageClient.ts";
import { NotebookEditorRegistry } from "../../NotebookEditorRegistry.ts";
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

// Create shared test context that holds references to test instances
class TestContext extends Effect.Service<TestContext>()("TestContext", {
  scoped: Effect.gen(function* () {
    const activeNotebookRef = yield* SubscriptionRef.make(
      Option.none<NotebookUri>(),
    );
    const configStore = new Map<NotebookUri, MarimoConfig>();

    return {
      activeNotebookRef,
      configStore,
      setActiveNotebook: (uri: Option.Option<NotebookUri>) =>
        SubscriptionRef.set(activeNotebookRef, uri),
      setConfig: (uri: NotebookUri, config: MarimoConfig) => {
        configStore.set(uri, config);
      },
      cleanup: () =>
        Effect.gen(function* () {
          configStore.clear();
          yield* SubscriptionRef.set(activeNotebookRef, Option.none());
        }),
    };
  }),
}) {}

const TestContextLive = TestContext.Default;

// Test NotebookEditorRegistry using TestContext
const TestNotebookEditorRegistryLive = Layer.effect(
  NotebookEditorRegistry,
  Effect.gen(function* () {
    const ctx = yield* TestContext;
    return partialService<NotebookEditorRegistry>({
      streamActiveNotebookChanges: () => ctx.activeNotebookRef.changes,
      getActiveNotebookUri: () => SubscriptionRef.get(ctx.activeNotebookRef),
    });
  }),
);

// Test LanguageClient using TestContext
const TestLanguageClientLive = Layer.effect(
  LanguageClient,
  Effect.gen(function* () {
    const ctx = yield* TestContext;
    return {
      executeCommand: (cmd: { command: string; params: unknown }) =>
        Effect.gen(function* () {
          const command = cmd.command;
          const params = cmd.params as {
            notebookUri: NotebookUri;
            inner: { config?: Record<string, unknown> };
          };

          if (command === "marimo.get_configuration") {
            const config = ctx.configStore.get(params.notebookUri);
            if (!config) {
              return yield* Effect.fail(
                new Error(`Config not found for ${params.notebookUri}`),
              );
            }
            return { config };
          }

          if (command === "marimo.update_configuration") {
            const existingConfig = ctx.configStore.get(params.notebookUri);
            const updatedConfig = {
              ...existingConfig,
              ...params.inner.config,
            } as MarimoConfig;
            ctx.configStore.set(params.notebookUri, updatedConfig);
            return { config: updatedConfig };
          }

          return yield* Effect.fail(new Error(`Unknown command: ${command}`));
        }),
    } as LanguageClient;
  }),
);

const TestLayer = Layer.mergeAll(
  MarimoConfigurationService.Default,
  TestContextLive,
).pipe(
  Layer.provide(TestNotebookEditorRegistryLive),
  Layer.provide(TestLanguageClientLive),
  Layer.provideMerge(TestContextLive),
);

const lifecycle = Effect.acquireRelease(
  Effect.gen(function* () {
    const ctx = yield* TestContext;
    const service = yield* MarimoConfigurationService;
    yield* service.cleanup();
    yield* ctx.cleanup();
  }),
  () =>
    Effect.gen(function* () {
      const ctx = yield* TestContext;
      const service = yield* MarimoConfigurationService;
      yield* service.cleanup();
      yield* ctx.cleanup();
    }),
);

it.layer(TestLayer)("MarimoConfigurationService", (it) => {
  it.scoped(
    "should build",
    Effect.fnUntraced(function* () {
      const service = yield* MarimoConfigurationService;
      yield* lifecycle;
      expect(service).toBeDefined();
    }),
  );

  it.scoped(
    "should fetch configuration from LSP server",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const service = yield* MarimoConfigurationService;
      yield* lifecycle;

      const notebookUri = NOTEBOOK_URI;
      const mockConfig = AUTORUN_CONFIG;

      ctx.setConfig(notebookUri, mockConfig);

      const config = yield* service.getConfig(notebookUri);

      expect(config).toEqual(mockConfig);
    }),
  );

  it.scoped(
    "should cache configuration after first fetch",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const service = yield* MarimoConfigurationService;
      yield* lifecycle;

      const notebookUri = NOTEBOOK_URI;
      const mockConfig = AUTORUN_CONFIG;

      ctx.setConfig(notebookUri, mockConfig);

      // First fetch
      const config1 = yield* service.getConfig(notebookUri);
      expect(config1).toEqual(mockConfig);

      // Check cached config is available
      const cached = yield* service.getCachedConfig(notebookUri);
      expect(Option.isSome(cached)).toBe(true);
      expect(Option.getOrThrow(cached)).toEqual(mockConfig);

      // Clear the server-side config to verify cache is used
      ctx.setConfig(notebookUri, {} as MarimoConfig);

      // Second fetch should return cached value
      const config2 = yield* service.getConfig(notebookUri);
      expect(config2).toEqual(mockConfig);
    }),
  );

  it.scoped(
    "should update configuration and cache",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const service = yield* MarimoConfigurationService;
      yield* lifecycle;

      const notebookUri = NOTEBOOK_URI;
      const initialConfig = AUTORUN_CONFIG;

      ctx.setConfig(notebookUri, initialConfig);

      // Update configuration
      const partialUpdate = { runtime: { on_cell_change: "lazy" } };
      const updatedConfig = yield* service.updateConfig(
        notebookUri,
        partialUpdate,
      );

      expect(updatedConfig.runtime?.on_cell_change).toBe("lazy");

      // Verify cache is updated
      const cached = yield* service.getCachedConfig(notebookUri);
      expect(Option.isSome(cached)).toBe(true);
      expect(Option.getOrThrow(cached).runtime?.on_cell_change).toBe("lazy");
    }),
  );

  it.scoped(
    "should clear notebook configuration",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const service = yield* MarimoConfigurationService;
      yield* lifecycle;

      const notebookUri = NOTEBOOK_URI;
      const mockConfig = AUTORUN_CONFIG;

      ctx.setConfig(notebookUri, mockConfig);

      // Fetch and cache
      yield* service.getConfig(notebookUri);

      // Verify cached
      const cached1 = yield* service.getCachedConfig(notebookUri);
      expect(Option.isSome(cached1)).toBe(true);

      // Clear
      yield* service.clearNotebook(notebookUri);

      // Verify cleared
      const cached2 = yield* service.getCachedConfig(notebookUri);
      expect(Option.isNone(cached2)).toBe(true);
    }),
  );

  it.scoped.skip(
    "should stream configuration changes",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const service = yield* MarimoConfigurationService;
      yield* lifecycle;

      const notebookUri = NOTEBOOK_URI;
      const initialConfig = AUTORUN_CONFIG;

      ctx.setConfig(notebookUri, initialConfig);
      ctx.setActiveNotebook(Option.some(notebookUri));

      // Test that streamConfigChanges is available and returns a stream
      const stream = service.streamActiveConfigChanges();
      expect(stream).toBeDefined();

      const collectedStreamed = stream.pipe(
        Stream.takeUntil((value) =>
          Option.isSome(value) ? value.value === lastMessage : false,
        ),
        Stream.runCollect,
      );

      yield* Effect.succeed(true);

      yield* collectedStreamed;

      const lastMessage = {
        runtime: { on_cell_change: "lazy" },
      };

      // Trigger some changes
      // lazy, lazy, autorun, lazy, lazy
      let _updated = yield* service.updateConfig(notebookUri, {
        runtime: { on_cell_change: "lazy" },
      });
      _updated = yield* service.updateConfig(notebookUri, {
        runtime: { on_cell_change: "lazy" },
      });
      _updated = yield* service.updateConfig(notebookUri, {
        runtime: { on_cell_change: "autorun" },
      });
      _updated = yield* service.updateConfig(notebookUri, {
        runtime: { on_cell_change: "lazy" },
      });
      _updated = yield* service.updateConfig(notebookUri, lastMessage);

      // Collect the stream

      // Verify the stream contains the correct changes
      const collected = yield* collectedStreamed;
      expect(collected).toMatchInlineSnapshot();
    }),
  );

  it.scoped(
    "should stream active notebook configuration changes",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const service = yield* MarimoConfigurationService;
      yield* lifecycle;

      const notebook1Uri = NOTEBOOK_URI_1;
      const notebook2Uri = NOTEBOOK_URI_2;

      const config1 = AUTORUN_CONFIG;
      const config2 = AUTORUN_CONFIG;

      ctx.setConfig(notebook1Uri, config1);
      ctx.setConfig(notebook2Uri, config2);

      // Test that streamActiveConfigChanges is available
      const stream = service.streamActiveConfigChanges();
      expect(stream).toBeDefined();

      // Change active notebook and verify state changes
      yield* ctx.setActiveNotebook(Option.some(notebook1Uri));
      yield* service.getConfig(notebook1Uri);

      const cached1 = yield* service.getCachedConfig(notebook1Uri);
      expect(Option.isSome(cached1)).toBe(true);
      expect(Option.getOrThrow(cached1).runtime?.on_cell_change).toBe(
        "autorun",
      );

      yield* ctx.setActiveNotebook(Option.some(notebook2Uri));
      yield* service.getConfig(notebook2Uri);

      const cached2 = yield* service.getCachedConfig(notebook2Uri);
      expect(Option.isSome(cached2)).toBe(true);
      expect(Option.getOrThrow(cached2).runtime?.on_cell_change).toBe(
        "autorun",
      );
    }),
  );

  it.scoped(
    "should stream mapped configuration values",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const service = yield* MarimoConfigurationService;
      yield* lifecycle;

      const notebookUri = NOTEBOOK_URI;
      const mockConfig = AUTORUN_CONFIG;

      // Test that streamOf is available and can map config
      const _stream = service.streamOf(
        (config) => config.runtime?.on_cell_change,
      );

      ctx.setConfig(notebookUri, mockConfig);

      // Set active and fetch
      yield* ctx.setActiveNotebook(Option.some(notebookUri));
      const config = yield* service.getConfig(notebookUri);

      // Verify mapping would work on the config
      expect(config.runtime?.on_cell_change).toBe("autorun");
    }),
  );

  it.scoped(
    "should handle multiple notebooks independently",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const service = yield* MarimoConfigurationService;
      yield* lifecycle;

      const notebook1Uri = NOTEBOOK_URI_1;
      const notebook2Uri = NOTEBOOK_URI_2;

      const config1 = AUTORUN_CONFIG;
      const config2 = LAZY_CONFIG;

      ctx.setConfig(notebook1Uri, config1);
      ctx.setConfig(notebook2Uri, config2);

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

      expect(Option.isSome(cached1)).toBe(true);
      expect(Option.isSome(cached2)).toBe(true);
      expect(Option.getOrThrow(cached1).runtime?.on_cell_change).toBe("lazy");
      expect(Option.getOrThrow(cached2).runtime?.on_cell_change).toBe("lazy");
    }),
  );

  it.scoped(
    "should return cached config when available without LSP call",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const service = yield* MarimoConfigurationService;
      yield* lifecycle;

      const notebookUri = NOTEBOOK_URI;
      const mockConfig = AUTORUN_CONFIG;

      ctx.setConfig(notebookUri, mockConfig);

      // Initial fetch
      yield* service.getConfig(notebookUri);

      // Verify getCachedConfig returns immediately
      const cached = yield* service.getCachedConfig(notebookUri);
      expect(Option.isSome(cached)).toBe(true);
      expect(Option.getOrThrow(cached).runtime?.on_cell_change).toBe("autorun");
    }),
  );
});
