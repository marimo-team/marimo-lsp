import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { makeTestMarimoClient } from "../../__tests__/__utils__/TestMarimoClient.ts";
import {
  marimoConfigFixture,
  mergeMarimoConfig,
  notebookId,
} from "../../lib/__tests__/branded.ts";
import { NotebookEditorRegistry } from "../../notebook/NotebookEditorRegistry.ts";
import { VsCode } from "../../platform/VsCode.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import * as Api from "../../schemas/Models.gen.ts";
import type { MarimoConfig } from "../../types.ts";
import { MarimoConfigurationService } from "../MarimoConfigurationService.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
const NOTEBOOK_URI_1 = notebookId("file:///test/notebook1.py");
const NOTEBOOK_URI_2 = notebookId("file:///test/notebook2.py");

const AUTORUN_CONFIG = marimoConfigFixture({
  runtime: { on_cell_change: "autorun" },
});

const LAZY_CONFIG = marimoConfigFixture({
  runtime: { on_cell_change: "lazy" },
});

const withTestCtx = Effect.fn(function* (
  // Keyed by plain string: the fake server looks up by the decoded wire
  // value, which carries no brand.
  options: {
    configStore?: Map<string, MarimoConfig>;
    // Pauses a response after its configuration snapshot is captured.
    beforeGetResponse?: (notebookUri: string) => Effect.Effect<void>;
  } = {},
) {
  const vscode = yield* TestVsCode.make();
  const { configStore = new Map<string, MarimoConfig>() } = options;

  const layer = MarimoConfigurationService.layer.pipe(
    Layer.provide(NotebookEditorRegistry.layer),
    Layer.provide(
      makeTestMarimoClient({
        execute: Effect.fn(function* (request) {
          if (request.method === "get-configuration") {
            const params = yield* Schema.decodeUnknownEffect(
              Api.GetConfigurationPayload,
            )(request.params);
            const config = configStore.get(params.notebookUri);
            if (config === undefined) {
              return yield* Effect.die(
                `Config not found for ${params.notebookUri}`,
              );
            }
            if (options.beforeGetResponse) {
              yield* options.beforeGetResponse(params.notebookUri);
            }
            return { config };
          }

          if (request.method === "update-configuration") {
            const params = yield* Schema.decodeUnknownEffect(
              Api.UpdateConfigurationPayload,
            )(request.params);
            const existing = configStore.get(params.notebookUri);
            if (existing === undefined) {
              return yield* Effect.die(
                `Config not found for ${params.notebookUri}`,
              );
            }
            const config = mergeMarimoConfig(existing, params.inner.config);
            configStore.set(params.notebookUri, config);
            return config;
          }

          return yield* Effect.die(
            `Unexpected marimo.api method: ${request.method}`,
          );
        }),
      }),
    ),
    Layer.provide(TestTelemetryLive),
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
    "should fetch configuration from the language server",
    Effect.fn(function* () {
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
    Effect.fn(function* () {
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

        // Clear the server-side config to verify cache is used
        yield* ctx.setConfig(notebookUri, marimoConfigFixture({}));

        // Second fetch should return cached value
        const config2 = yield* service.getConfig(notebookUri);
        expect(config2).toEqual(mockConfig);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "should update configuration and cache",
    Effect.fn(function* () {
      const notebookUri = NOTEBOOK_URI;
      const initialConfig = AUTORUN_CONFIG;

      const ctx = yield* withTestCtx({
        configStore: new Map([[notebookUri, initialConfig]]),
      });

      yield* Effect.gen(function* () {
        const service = yield* MarimoConfigurationService;

        // Update configuration
        const partialUpdate = { runtime: { on_cell_change: "lazy" } };
        const updatedConfig = yield* service.updateConfig(
          notebookUri,
          partialUpdate,
        );
        expect(updatedConfig.runtime?.on_cell_change).toBe("lazy");

        // Reads are served from the updated cache, not the server
        yield* ctx.setConfig(notebookUri, marimoConfigFixture({}));
        const cached = yield* service.getConfig(notebookUri);
        expect(cached.runtime?.on_cell_change).toBe("lazy");
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "should refetch after clearNotebook",
    Effect.fn(function* () {
      const notebookUri = NOTEBOOK_URI;

      const ctx = yield* withTestCtx({
        configStore: new Map([[notebookUri, AUTORUN_CONFIG]]),
      });

      yield* Effect.gen(function* () {
        const service = yield* MarimoConfigurationService;

        // Fetch and cache
        const config1 = yield* service.getConfig(notebookUri);
        expect(config1.runtime?.on_cell_change).toBe("autorun");

        // Clear, then change what the server would return
        yield* service.clearNotebook(notebookUri);
        yield* ctx.setConfig(notebookUri, LAZY_CONFIG);

        // Next read must go back to the server
        const config2 = yield* service.getConfig(notebookUri);
        expect(config2.runtime?.on_cell_change).toBe("lazy");
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "should evict the cache when the notebook closes",
    Effect.fn(function* () {
      const notebookUri = NOTEBOOK_URI;

      const ctx = yield* withTestCtx({
        configStore: new Map([[notebookUri, AUTORUN_CONFIG]]),
      });

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const service = yield* MarimoConfigurationService;

        const doc = createTestNotebookDocument(
          code.Uri.parse(notebookUri, true),
        );
        yield* ctx.vscode.addNotebookDocument(doc);
        // Let the service's close-subscription fiber attach before events fire
        yield* TestClock.adjust("10 millis");

        const config1 = yield* service.getConfig(notebookUri);
        expect(config1.runtime?.on_cell_change).toBe("autorun");

        // Close the notebook; the cached entry must be evicted so a
        // reopened notebook sees the (possibly changed) server config.
        yield* ctx.setConfig(notebookUri, LAZY_CONFIG);
        yield* ctx.vscode.closeNotebook(doc);
        yield* TestClock.adjust("10 millis");

        const config2 = yield* service.getConfig(notebookUri);
        expect(config2.runtime?.on_cell_change).toBe("lazy");
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "does not restore cache entries from requests invalidated while in flight",
    Effect.fn(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const ctx = yield* withTestCtx({
        configStore: new Map([[NOTEBOOK_URI, AUTORUN_CONFIG]]),
        beforeGetResponse: () =>
          Deferred.succeed(requestStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRequest)),
          ),
      });

      yield* Effect.gen(function* () {
        const service = yield* MarimoConfigurationService;
        const pending = yield* Effect.forkChild(
          service.getConfig(NOTEBOOK_URI),
        );
        yield* Deferred.await(requestStarted);

        yield* service.clearNotebook(NOTEBOOK_URI);
        yield* ctx.setConfig(NOTEBOOK_URI, LAZY_CONFIG);
        yield* Deferred.succeed(releaseRequest, undefined);

        // The original caller still receives its completed response.
        expect((yield* Fiber.join(pending)).runtime?.on_cell_change).toBe(
          "autorun",
        );
        // The invalid response was not cached; this fetch reaches the server.
        expect(
          (yield* service.getConfig(NOTEBOOK_URI)).runtime?.on_cell_change,
        ).toBe("lazy");
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "ignores a delayed close from a replaced document at the same URI",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx({
        configStore: new Map([[NOTEBOOK_URI, AUTORUN_CONFIG]]),
      });

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const service = yield* MarimoConfigurationService;
        const first = createTestNotebookDocument(
          code.Uri.parse(NOTEBOOK_URI, true),
        );
        const replacement = createTestNotebookDocument(
          code.Uri.parse(NOTEBOOK_URI, true),
        );

        yield* ctx.vscode.openNotebook(first);
        yield* TestClock.adjust("1 millis");
        expect(
          (yield* service.getConfig(NOTEBOOK_URI)).runtime?.on_cell_change,
        ).toBe("autorun");

        yield* ctx.setConfig(NOTEBOOK_URI, LAZY_CONFIG);
        yield* ctx.vscode.openNotebook(replacement);
        yield* TestClock.adjust("1 millis");
        expect(
          (yield* service.getConfig(NOTEBOOK_URI)).runtime?.on_cell_change,
        ).toBe("lazy");

        // The old close must not evict the replacement session's cache.
        yield* ctx.setConfig(NOTEBOOK_URI, AUTORUN_CONFIG);
        yield* ctx.vscode.closeNotebook(first);
        yield* TestClock.adjust("1 millis");
        expect(
          (yield* service.getConfig(NOTEBOOK_URI)).runtime?.on_cell_change,
        ).toBe("lazy");
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "should stream configuration changes and dedupe",
    Effect.fn(function* () {
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

        const stream = service.streamOf(
          (config) => config.runtime?.on_cell_change,
        );

        const collectedStreamed = yield* Effect.forkChild(
          stream.pipe(Stream.take(4), Stream.runCollect),
        );

        // v4 attaches the stream's inner PubSub subscriptions lazily and each
        // TestClock.adjust performs a single scheduler drain; drain twice so
        // the consumer is subscribed before the updates below fire.
        yield* TestClock.adjust("10 millis");
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

        // Verify the stream contains the correct changes
        const collected = yield* Fiber.join(collectedStreamed);
        expect(collected).toMatchInlineSnapshot(`
          [
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
          ]
        `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "should stream configuration changes when active notebook changes",
    Effect.fn(function* () {
      const notebook1Uri = NOTEBOOK_URI_1;
      const notebook2Uri = NOTEBOOK_URI_2;

      const ctx = yield* withTestCtx({
        configStore: new Map([
          [notebook1Uri, AUTORUN_CONFIG],
          [notebook2Uri, LAZY_CONFIG],
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

        const stream = service.streamOf(
          (config) => config.runtime?.on_cell_change,
        );

        const collectedStreamed = yield* Effect.forkChild(
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

        yield* ctx.vscode.setActiveNotebookEditor(
          Option.some(createTestNotebookEditor(doc2)),
        );
        yield* TestClock.adjust("10 millis");

        yield* service.getConfig(notebook2Uri);
        yield* TestClock.adjust("10 millis");

        yield* service.updateConfig(notebook2Uri, AUTORUN_CONFIG);
        yield* TestClock.adjust("10 millis");

        const collected = yield* Fiber.join(collectedStreamed);
        expect(collected).toMatchInlineSnapshot(`
          [
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
          ]
        `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "should handle multiple notebooks independently",
    Effect.fn(function* () {
      const notebook1Uri = NOTEBOOK_URI_1;
      const notebook2Uri = NOTEBOOK_URI_2;

      const ctx = yield* withTestCtx({
        configStore: new Map([
          [notebook1Uri, AUTORUN_CONFIG],
          [notebook2Uri, LAZY_CONFIG],
        ]),
      });

      yield* Effect.gen(function* () {
        const service = yield* MarimoConfigurationService;

        // Fetch both
        const fetchedConfig1 = yield* service.getConfig(notebook1Uri);
        const fetchedConfig2 = yield* service.getConfig(notebook2Uri);

        expect(fetchedConfig1.runtime?.on_cell_change).toBe("autorun");
        expect(fetchedConfig2.runtime?.on_cell_change).toBe("lazy");

        // Update one; the other's cache must be untouched
        yield* service.updateConfig(notebook1Uri, {
          runtime: { on_cell_change: "lazy" },
        });

        const cached1 = yield* service.getConfig(notebook1Uri);
        const cached2 = yield* service.getConfig(notebook2Uri);
        expect(cached1.runtime?.on_cell_change).toBe("lazy");
        expect(cached2.runtime?.on_cell_change).toBe("lazy");
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "should stream auto_reload configuration changes and dedupe",
    Effect.fn(function* () {
      const notebookUri = NOTEBOOK_URI;
      const initialConfig = marimoConfigFixture({
        runtime: { auto_reload: "off" },
      });

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

        const stream = service.streamOf(
          (config) => config.runtime?.auto_reload,
        );

        const collectedStreamed = yield* Effect.forkChild(
          stream.pipe(Stream.take(4), Stream.runCollect),
        );

        // v4 attaches the stream's inner PubSub subscriptions lazily and each
        // TestClock.adjust performs a single scheduler drain; drain twice so
        // the consumer is subscribed before the updates below fire.
        yield* TestClock.adjust("10 millis");
        yield* TestClock.adjust("10 millis");

        // Trigger some changes
        // lazy, lazy, autorun, lazy, lazy
        yield* service.updateConfig(notebookUri, {
          runtime: { auto_reload: "lazy" },
        });
        yield* service.updateConfig(notebookUri, {
          runtime: { auto_reload: "lazy" },
        });
        yield* service.updateConfig(notebookUri, {
          runtime: { auto_reload: "autorun" },
        });
        yield* service.updateConfig(notebookUri, {
          runtime: { auto_reload: "lazy" },
        });
        yield* service.updateConfig(notebookUri, {
          runtime: { auto_reload: "lazy" },
        });

        yield* TestClock.adjust("10 millis");

        const collected = yield* Fiber.join(collectedStreamed);
        expect(collected).toMatchInlineSnapshot(`
          [
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
          ]
        `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
