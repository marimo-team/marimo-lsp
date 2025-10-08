import { expect, it } from "@effect/vitest";
import {
  Effect,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
  TestClock,
} from "effect";
import { partialService } from "../../../__tests__/__utils__/partial.ts";
import type { MarimoConfig, NotebookUri } from "../../../types.ts";
import { LanguageClient } from "../../LanguageClient.ts";
import { NotebookEditorRegistry } from "../../NotebookEditorRegistry.ts";
import type { VsCode } from "../../VsCode.ts";
import { VsCode as VsCodeService } from "../../VsCode.ts";
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

// Test context that tracks VSCode context calls
class TestContext extends Effect.Service<TestContext>()("TestContext", {
  scoped: Effect.gen(function* () {
    const activeNotebookRef = yield* SubscriptionRef.make(
      Option.none<NotebookUri>(),
    );
    const configStore = new Map<NotebookUri, MarimoConfig>();
    const contextCalls: Array<{ key: string; value: unknown }> = [];

    return {
      activeNotebookRef,
      configStore,
      contextCalls,
      setActiveNotebook: (uri: Option.Option<NotebookUri>) =>
        SubscriptionRef.set(activeNotebookRef, uri),
      setConfig: (uri: NotebookUri, config: MarimoConfig) => {
        configStore.set(uri, config);
        return Effect.void;
      },
      recordContextCall: (key: string, value: unknown) =>
        Effect.sync(() => {
          contextCalls.push({ key, value });
        }),
      getContextCalls: () => Effect.succeed([...contextCalls]),
      clearContextCalls: () =>
        Effect.sync(() => {
          contextCalls.length = 0;
        }),
      cleanup: () =>
        Effect.gen(function* () {
          configStore.clear();
          contextCalls.length = 0;
          yield* SubscriptionRef.set(activeNotebookRef, Option.none());
        }),
    };
  }),
}) {}

const TestContextLive = TestContext.Default;

// Mock VsCode service
const TestVsCodeLive = Layer.effect(
  VsCodeService,
  Effect.gen(function* () {
    const ctx = yield* TestContext;
    return partialService<VsCode>({
      commands: {
        setContext: (key: string, value: unknown) =>
          ctx.recordContextCall(key, value),
        executeCommand: () => Effect.void,
        registerCommand: () => Effect.void,
        _tag: "Commands",
      },
    });
  }),
);

// Test NotebookEditorRegistry
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

// Test LanguageClient
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
  ConfigContextManager.Default,
  MarimoConfigurationService.Default,
  TestContextLive,
).pipe(
  Layer.provide(TestVsCodeLive),
  Layer.provide(TestNotebookEditorRegistryLive),
  Layer.provide(TestLanguageClientLive),
  Layer.provideMerge(TestContextLive),
);

const lifecycle = Effect.gen(function* () {
  const ctx = yield* TestContext;
  const configService = yield* MarimoConfigurationService;
  yield* configService.cleanup();
  yield* ctx.cleanup();
});

it.layer(TestLayer)("ConfigContextManager", (it) => {
  it.scoped(
    "should build",
    Effect.fnUntraced(function* () {
      const manager = yield* ConfigContextManager;
      yield* lifecycle;
      expect(manager).toBeDefined();
    }),
  );

  it.scoped(
    "should update VSCode context when config changes",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const configService = yield* MarimoConfigurationService;
      const _manager = yield* ConfigContextManager;

      const notebookUri = NOTEBOOK_URI;
      yield* ctx.setConfig(notebookUri, AUTORUN_CONFIG);
      yield* ctx.setActiveNotebook(Option.some(notebookUri));

      yield* TestClock.adjust("10 millis");

      // Fetch config to populate cache
      yield* configService.getConfig(notebookUri);
      yield* TestClock.adjust("10 millis");

      // Update to lazy
      yield* configService.updateConfig(notebookUri, LAZY_CONFIG);
      yield* TestClock.adjust("10 millis");

      const calls = yield* ctx.getContextCalls();

      // Should have at least 2 calls: initial (autorun) and update (lazy)
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls.some((c) => c.value === "autorun")).toBe(true);
      expect(calls.some((c) => c.value === "lazy")).toBe(true);

      yield* lifecycle;
    }),
  );

  it.scoped(
    "should default to autorun when config is None",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const _manager = yield* ConfigContextManager;

      yield* TestClock.adjust("10 millis");

      const calls = yield* ctx.getContextCalls();

      // Initial context should be set to autorun (default)
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].key).toBe("marimo.config.runtime.on_cell_change");
      expect(calls[0].value).toBe("autorun");

      yield* lifecycle;
    }),
  );

  it.scoped(
    "should stream on_cell_change mode changes",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const configService = yield* MarimoConfigurationService;
      const manager = yield* ConfigContextManager;

      const notebookUri = NOTEBOOK_URI;
      yield* ctx.setConfig(notebookUri, AUTORUN_CONFIG);
      yield* ctx.setActiveNotebook(Option.some(notebookUri));

      const stream = manager.streamOnCellChangeModeChanges();
      const collectedStreamed = yield* Effect.fork(
        stream.pipe(Stream.take(4), Stream.runCollect),
      );

      yield* TestClock.adjust("10 millis");

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

      yield* lifecycle;
    }),
  );

  it.scoped(
    "should handle switching between notebooks",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const configService = yield* MarimoConfigurationService;
      const _manager = yield* ConfigContextManager;

      yield* ctx.setConfig(NOTEBOOK_URI_1, AUTORUN_CONFIG);
      yield* ctx.setConfig(NOTEBOOK_URI_2, LAZY_CONFIG);

      yield* ctx.clearContextCalls();

      // Switch to notebook 1
      yield* ctx.setActiveNotebook(Option.some(NOTEBOOK_URI_1));
      yield* configService.getConfig(NOTEBOOK_URI_1);
      yield* TestClock.adjust("10 millis");

      let calls = yield* ctx.getContextCalls();
      expect(calls[calls.length - 1].value).toBe("autorun");

      // Switch to notebook 2
      yield* ctx.setActiveNotebook(Option.some(NOTEBOOK_URI_2));
      yield* configService.getConfig(NOTEBOOK_URI_2);
      yield* TestClock.adjust("10 millis");

      calls = yield* ctx.getContextCalls();
      expect(calls[calls.length - 1].value).toBe("lazy");

      yield* lifecycle;
    }),
  );
});
