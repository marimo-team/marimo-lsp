import { expect, it } from "@effect/vitest";
import {
  Effect,
  Layer,
  Option,
  Queue,
  Stream,
  SubscriptionRef,
  TestClock,
} from "effect";

import type { NotebookId } from "../../../schemas.ts";
import type { MarimoConfig } from "../../../types.ts";
import type { VsCode } from "../../VsCode.ts";

import { partialService } from "../../../__tests__/__utils__/partial.ts";
import { LanguageClient } from "../../LanguageClient.ts";
import { NotebookEditorRegistry } from "../../NotebookEditorRegistry.ts";
import { VsCode as VsCodeService } from "../../VsCode.ts";
import { ConfigContextManager } from "../ConfigContextManager.ts";
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

const AUTO_RELOAD_LAZY_CONFIG = {
  runtime: {
    on_cell_change: "autorun",
    auto_reload: "lazy",
  },
} as MarimoConfig;

const AUTO_RELOAD_AUTORUN_CONFIG = {
  runtime: {
    on_cell_change: "autorun",
    auto_reload: "autorun",
  },
} as MarimoConfig;

// Test context that tracks VSCode context calls
class TestContext extends Effect.Service<TestContext>()("TestContext", {
  scoped: Effect.gen(function* () {
    const activeNotebookRef = yield* SubscriptionRef.make(
      Option.none<NotebookId>(),
    );
    const configStore = new Map<NotebookId, MarimoConfig>();
    const contextCalls: Array<{ key: string; value: unknown }> = [];

    return {
      activeNotebookRef,
      configStore,
      contextCalls,
      setActiveNotebook: (uri: Option.Option<NotebookId>) =>
        SubscriptionRef.set(activeNotebookRef, uri),
      setConfig: (uri: NotebookId, config: MarimoConfig) => {
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
        subscribeToCommands() {
          return Queue.unbounded();
        },
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
      executeCommand: ({ command, params }) =>
        Effect.gen(function* () {
          if (!(command === "marimo.api")) {
            return yield* Effect.fail(new Error(`Unknown command: ${command}`));
          }

          if (params.method === "get-configuration") {
            const config = ctx.configStore.get(params.params.notebookUri);
            if (!config) {
              return yield* Effect.fail(
                new Error(`Config not found for ${params.params.notebookUri}`),
              );
            }
            return { config };
          }

          if (params.method === "update-configuration") {
            const existing = ctx.configStore.get(params.params.notebookUri);
            if (existing === undefined) {
              return yield* Effect.die(
                `Config not found for ${params.params.notebookUri}`,
              );
            }
            const config = {
              ...existing,
              ...params.params.inner.config,
            };
            ctx.configStore.set(params.params.notebookUri, config);
            return { config };
          }

          return yield* Effect.fail(
            new Error(`Unknown marimo.api method: ${params.method}`),
          );
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
      let onCellChangeCalls = calls.filter(
        (c) => c.key === "marimo.config.runtime.on_cell_change",
      );
      expect(onCellChangeCalls[onCellChangeCalls.length - 1].value).toBe(
        "autorun",
      );

      // Switch to notebook 2
      yield* ctx.setActiveNotebook(Option.some(NOTEBOOK_URI_2));
      yield* configService.getConfig(NOTEBOOK_URI_2);
      yield* TestClock.adjust("10 millis");

      calls = yield* ctx.getContextCalls();
      onCellChangeCalls = calls.filter(
        (c) => c.key === "marimo.config.runtime.on_cell_change",
      );
      expect(onCellChangeCalls[onCellChangeCalls.length - 1].value).toBe(
        "lazy",
      );

      yield* lifecycle;
    }),
  );

  it.scoped(
    "should default auto_reload to off when config is None",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const _manager = yield* ConfigContextManager;

      yield* TestClock.adjust("10 millis");

      const calls = yield* ctx.getContextCalls();

      // Should have context for auto_reload set to "off" (default)
      const autoReloadCalls = calls.filter(
        (c) => c.key === "marimo.config.runtime.auto_reload",
      );
      expect(autoReloadCalls.length).toBeGreaterThanOrEqual(1);
      expect(autoReloadCalls[0].value).toBe("off");

      yield* lifecycle;
    }),
  );

  it.scoped(
    "should update auto_reload context when config changes",
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

      // Update to auto_reload lazy
      yield* configService.updateConfig(notebookUri, AUTO_RELOAD_LAZY_CONFIG);
      yield* TestClock.adjust("10 millis");

      // Update to auto_reload autorun
      yield* configService.updateConfig(
        notebookUri,
        AUTO_RELOAD_AUTORUN_CONFIG,
      );
      yield* TestClock.adjust("10 millis");

      const calls = yield* ctx.getContextCalls();
      const autoReloadCalls = calls.filter(
        (c) => c.key === "marimo.config.runtime.auto_reload",
      );

      // Should have updates: off (default/initial) -> lazy -> autorun
      expect(autoReloadCalls.some((c) => c.value === "off")).toBe(true);
      expect(autoReloadCalls.some((c) => c.value === "lazy")).toBe(true);
      expect(autoReloadCalls.some((c) => c.value === "autorun")).toBe(true);

      yield* lifecycle;
    }),
  );

  it.scoped(
    "should stream auto_reload mode changes",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const configService = yield* MarimoConfigurationService;
      const manager = yield* ConfigContextManager;

      const notebookUri = NOTEBOOK_URI;
      yield* ctx.setConfig(notebookUri, AUTORUN_CONFIG);
      yield* ctx.setActiveNotebook(Option.some(notebookUri));

      const stream = manager.streamAutoReloadModeChanges();
      const collectedStreamed = yield* Effect.fork(
        stream.pipe(Stream.take(4), Stream.runCollect),
      );

      yield* TestClock.adjust("10 millis");

      // Fetch initial config
      yield* configService.getConfig(notebookUri);
      yield* TestClock.adjust("10 millis");

      // Make changes
      yield* configService.updateConfig(notebookUri, AUTO_RELOAD_LAZY_CONFIG);
      yield* TestClock.adjust("10 millis");

      yield* configService.updateConfig(
        notebookUri,
        AUTO_RELOAD_AUTORUN_CONFIG,
      );
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
              "value": undefined,
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
    "should handle switching between notebooks with different auto_reload configs",
    Effect.fnUntraced(function* () {
      const ctx = yield* TestContext;
      const configService = yield* MarimoConfigurationService;
      const _manager = yield* ConfigContextManager;

      yield* ctx.setConfig(NOTEBOOK_URI_1, AUTO_RELOAD_LAZY_CONFIG);
      yield* ctx.setConfig(NOTEBOOK_URI_2, AUTO_RELOAD_AUTORUN_CONFIG);

      yield* ctx.clearContextCalls();

      // Switch to notebook 1
      yield* ctx.setActiveNotebook(Option.some(NOTEBOOK_URI_1));
      yield* configService.getConfig(NOTEBOOK_URI_1);
      yield* TestClock.adjust("10 millis");

      let calls = yield* ctx.getContextCalls();
      let autoReloadCalls = calls.filter(
        (c) => c.key === "marimo.config.runtime.auto_reload",
      );
      expect(autoReloadCalls[autoReloadCalls.length - 1].value).toBe("lazy");

      // Switch to notebook 2
      yield* ctx.setActiveNotebook(Option.some(NOTEBOOK_URI_2));
      yield* configService.getConfig(NOTEBOOK_URI_2);
      yield* TestClock.adjust("10 millis");

      calls = yield* ctx.getContextCalls();
      autoReloadCalls = calls.filter(
        (c) => c.key === "marimo.config.runtime.auto_reload",
      );
      expect(autoReloadCalls[autoReloadCalls.length - 1].value).toBe("autorun");

      yield* lifecycle;
    }),
  );
});
