import { assert, describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  createTestNotebookDocument,
  TestVsCode,
  Uri,
} from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import {
  marimoConfigFixture,
  mergeMarimoConfig,
  notebookId,
} from "../../lib/__tests__/branded.ts";
import { NotebookDocumentSessions } from "../../notebook/NotebookDocumentSessions.ts";
import { NotebookSessionResources } from "../../notebook/NotebookSessionResources.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import * as Api from "../../schemas/Models.gen.ts";
import type { MarimoConfig } from "../../types.ts";
import { NotebookConfiguration } from "../NotebookConfiguration.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
const NOTEBOOK_URI_1 = notebookId("file:///test/notebook1.py");
const NOTEBOOK_URI_2 = notebookId("file:///test/notebook2.py");

const AUTORUN_CONFIG = marimoConfigFixture({
  runtime: { on_cell_change: "autorun" },
});
const LAZY_CONFIG = marimoConfigFixture({
  runtime: { on_cell_change: "lazy" },
});

const inNotebook = <A, E, R>(
  notebookUri: NotebookId,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sessions = yield* NotebookDocumentSessions;
    const resources = yield* NotebookSessionResources;
    const session = sessions.current(notebookUri);
    assert(session !== undefined);
    return yield* resources.run(session, effect);
  });

const getConfig = (notebookUri: NotebookId) =>
  inNotebook(
    notebookUri,
    NotebookConfiguration.pipe(
      Effect.flatMap((configuration) => configuration.get),
    ),
  );

const updateConfig = (
  notebookUri: NotebookId,
  partialConfig: Record<string, unknown>,
) =>
  inNotebook(
    notebookUri,
    NotebookConfiguration.pipe(
      Effect.flatMap((configuration) => configuration.update(partialConfig)),
    ),
  );

const invalidateConfig = (notebookUri: NotebookId) =>
  inNotebook(
    notebookUri,
    NotebookConfiguration.pipe(
      Effect.flatMap((configuration) => configuration.invalidate),
    ),
  );

const configurationChanges = (notebookUri: NotebookId) =>
  Effect.gen(function* () {
    const sessions = yield* NotebookDocumentSessions;
    const resources = yield* NotebookSessionResources;
    const session = sessions.current(notebookUri);
    assert(session !== undefined);
    return resources.stream(
      session,
      Stream.unwrap(
        NotebookConfiguration.pipe(
          Effect.map((configuration) => configuration.changes),
        ),
      ),
    );
  });

const withTestCtx = Effect.fn(function* (
  options: {
    configStore?: Map<string, MarimoConfig>;
    beforeGetResponse?: (notebookUri: string) => Effect.Effect<void>;
  } = {},
) {
  const { configStore = new Map<string, MarimoConfig>() } = options;
  const initialDocuments = Array.from(configStore.keys(), (uri) =>
    createTestNotebookDocument(Uri.parse(uri)),
  );
  const vscode = yield* TestVsCode.make({ initialDocuments });

  const runtime = makeTestNotebookRuntime({
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
  });
  const documentSessions = NotebookDocumentSessions.layer.pipe(
    Layer.provide(vscode.layer),
  );
  const sessionResources = NotebookSessionResources.layer.pipe(
    Layer.provide(documentSessions),
    Layer.provide(runtime),
  );

  return {
    vscode,
    initialDocuments,
    layer: Layer.mergeAll(vscode.layer, documentSessions, sessionResources),
    setConfig(uri: NotebookId, config: MarimoConfig) {
      configStore.set(uri, config);
      return Effect.void;
    },
  };
});

describe("NotebookConfiguration", () => {
  it.effect("fetches once and caches within a document session", () =>
    Effect.gen(function* () {
      const ctx = yield* withTestCtx({
        configStore: new Map([[NOTEBOOK_URI, AUTORUN_CONFIG]]),
      });

      yield* Effect.gen(function* () {
        expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);
        yield* ctx.setConfig(NOTEBOOK_URI, marimoConfigFixture({}));
        expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect("shares an in-flight lookup", () =>
    Effect.gen(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      let requests = 0;
      const ctx = yield* withTestCtx({
        configStore: new Map([[NOTEBOOK_URI, AUTORUN_CONFIG]]),
        beforeGetResponse: () =>
          Effect.sync(() => {
            requests += 1;
          }).pipe(
            Effect.andThen(Deferred.succeed(requestStarted, undefined)),
            Effect.andThen(Deferred.await(releaseRequest)),
          ),
      });

      yield* Effect.gen(function* () {
        const lookups = yield* Effect.forkChild(
          Effect.all([getConfig(NOTEBOOK_URI), getConfig(NOTEBOOK_URI)], {
            concurrency: "unbounded",
          }),
        );
        yield* Deferred.await(requestStarted);
        expect(requests).toBe(1);
        yield* Deferred.succeed(releaseRequest, undefined);
        expect(yield* Fiber.join(lookups)).toEqual([
          AUTORUN_CONFIG,
          AUTORUN_CONFIG,
        ]);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect("updates the cached value and publishes changes", () =>
    Effect.gen(function* () {
      const ctx = yield* withTestCtx({
        configStore: new Map([[NOTEBOOK_URI, AUTORUN_CONFIG]]),
      });

      yield* Effect.gen(function* () {
        const stream = yield* configurationChanges(NOTEBOOK_URI);
        const collected = yield* Effect.forkChild(
          stream.pipe(Stream.take(3), Stream.runCollect),
        );
        yield* TestClock.adjust("1 millis");

        yield* updateConfig(NOTEBOOK_URI, {
          runtime: { on_cell_change: "lazy" },
        });
        yield* updateConfig(NOTEBOOK_URI, {
          runtime: { on_cell_change: "autorun" },
        });

        const changes = yield* Fiber.join(collected);
        expect(changes[0]?._tag).toBe("None");
        expect(changes[1]).toEqual(Option.some(LAZY_CONFIG));
        expect(changes[2]).toEqual(Option.some(AUTORUN_CONFIG));
        expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect("does not recache a lookup invalidated while in flight", () =>
    Effect.gen(function* () {
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
        const pending = yield* Effect.forkChild(getConfig(NOTEBOOK_URI));
        yield* Deferred.await(requestStarted);
        yield* invalidateConfig(NOTEBOOK_URI);
        yield* ctx.setConfig(NOTEBOOK_URI, LAZY_CONFIG);
        yield* Deferred.succeed(releaseRequest, undefined);

        expect(yield* Fiber.join(pending)).toEqual(AUTORUN_CONFIG);
        expect(yield* getConfig(NOTEBOOK_URI)).toEqual(LAZY_CONFIG);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect("evicts resources when a document session ends", () =>
    Effect.gen(function* () {
      const ctx = yield* withTestCtx({
        configStore: new Map([[NOTEBOOK_URI, AUTORUN_CONFIG]]),
      });

      yield* Effect.gen(function* () {
        const document = ctx.initialDocuments[0];
        assert(document !== undefined);
        expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);

        yield* ctx.vscode.closeNotebook(document);
        yield* ctx.setConfig(NOTEBOOK_URI, LAZY_CONFIG);
        const replacement = createTestNotebookDocument(Uri.parse(NOTEBOOK_URI));
        yield* ctx.vscode.openNotebook(replacement);
        yield* TestClock.adjust("1 millis");

        expect(yield* getConfig(NOTEBOOK_URI)).toEqual(LAZY_CONFIG);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect("ignores a delayed close from a replaced document", () =>
    Effect.gen(function* () {
      const ctx = yield* withTestCtx({
        configStore: new Map([[NOTEBOOK_URI, AUTORUN_CONFIG]]),
      });

      yield* Effect.gen(function* () {
        const first = ctx.initialDocuments[0];
        assert(first !== undefined);
        expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);

        yield* ctx.setConfig(NOTEBOOK_URI, LAZY_CONFIG);
        const replacement = createTestNotebookDocument(Uri.parse(NOTEBOOK_URI));
        yield* ctx.vscode.openNotebook(replacement);
        yield* TestClock.adjust("1 millis");
        expect(yield* getConfig(NOTEBOOK_URI)).toEqual(LAZY_CONFIG);

        yield* ctx.setConfig(NOTEBOOK_URI, AUTORUN_CONFIG);
        yield* ctx.vscode.closeNotebook(first);
        yield* TestClock.adjust("1 millis");
        expect(yield* getConfig(NOTEBOOK_URI)).toEqual(LAZY_CONFIG);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect("isolates concurrent notebook sessions", () =>
    Effect.gen(function* () {
      const ctx = yield* withTestCtx({
        configStore: new Map([
          [NOTEBOOK_URI_1, AUTORUN_CONFIG],
          [NOTEBOOK_URI_2, LAZY_CONFIG],
        ]),
      });

      yield* Effect.gen(function* () {
        expect(yield* getConfig(NOTEBOOK_URI_1)).toEqual(AUTORUN_CONFIG);
        expect(yield* getConfig(NOTEBOOK_URI_2)).toEqual(LAZY_CONFIG);

        yield* updateConfig(NOTEBOOK_URI_1, {
          runtime: { on_cell_change: "lazy" },
        });
        expect(yield* getConfig(NOTEBOOK_URI_1)).toEqual(LAZY_CONFIG);
        expect(yield* getConfig(NOTEBOOK_URI_2)).toEqual(LAZY_CONFIG);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
