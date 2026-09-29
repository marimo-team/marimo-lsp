import * as Vitest from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Latch,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect";
import type * as vscode from "vscode";

import * as MarimoClientTest from "../../__tests__/fake/MarimoClient.ts";
import * as NotebookRuntimeTest from "../../__tests__/fake/NotebookRuntime.ts";
import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import {
  marimoConfigFixture,
  mergeMarimoConfig,
  notebookId,
} from "../../lib/__tests__/branded.ts";
import * as DocumentLifecycle from "../../notebook/__tests__/documentLifecycle.ts";
import * as NotebookDocumentSessions from "../../notebook/NotebookDocumentSessions.ts";
import * as NotebookSessionResources from "../../notebook/NotebookSessionResources.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { MarimoConfig } from "../../types.ts";
import * as NotebookConfiguration from "../NotebookConfiguration.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
const NOTEBOOK_URI_1 = notebookId("file:///test/notebook1.py");
const NOTEBOOK_URI_2 = notebookId("file:///test/notebook2.py");

const AUTORUN_CONFIG = marimoConfigFixture({
  runtime: { on_cell_change: "autorun" },
});
const LAZY_CONFIG = marimoConfigFixture({
  runtime: { on_cell_change: "lazy" },
});
const AUTO_RELOAD_CONFIG = marimoConfigFixture({
  runtime: { on_cell_change: "autorun", auto_reload: "autorun" },
});

interface RequestGate {
  readonly started: Latch.Latch;
  readonly release: Latch.Latch;
}

/** The fake marimo server's configuration store and request pause queues. */
class Server extends Context.Service<
  Server,
  {
    readonly configs: Ref.Ref<ReadonlyMap<NotebookId, MarimoConfig>>;
    readonly documents: Map<NotebookId, vscode.NotebookDocument>;
    readonly nextGetPauses: Queue.Queue<RequestGate>;
    readonly nextUpdatePauses: Queue.Queue<RequestGate>;
  }
>()("@marimo/test/NotebookConfiguration/Server") {}

const pauseAt = Effect.fn(function* (queue: Queue.Queue<RequestGate>) {
  const gate = yield* Queue.poll(queue);
  if (Option.isNone(gate)) return;
  yield* gate.value.started.open;
  yield* gate.value.release.await;
});

const layerWith = (initialConfigs: ReadonlyMap<NotebookId, MarimoConfig>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const configs =
        yield* Ref.make<ReadonlyMap<NotebookId, MarimoConfig>>(initialConfigs);
      const nextGetPauses = yield* Queue.unbounded<RequestGate>();
      const nextUpdatePauses = yield* Queue.unbounded<RequestGate>();
      const documents = new Map(
        Array.from(
          initialConfigs.keys(),
          (notebookId) =>
            [
              notebookId,
              VsCodeTest.createTestNotebookDocument(
                VsCodeTest.Uri.parse(notebookId),
              ),
            ] as const,
        ),
      );

      const runtimeLayer = NotebookRuntimeTest.layerWith({
        send: Effect.fn(function* (request) {
          if (request.kind === "get-configuration") {
            const id = notebookId(request.notebookUri);
            const config = (yield* Ref.get(configs)).get(id);
            if (config === undefined) {
              return yield* Effect.die(
                `Config not found for ${request.notebookUri}`,
              );
            }
            yield* pauseAt(nextGetPauses);
            return { config };
          }

          if (request.kind === "update-configuration") {
            yield* pauseAt(nextUpdatePauses);
            const id = notebookId(request.notebookUri);
            return yield* Ref.modify(configs, (current) => {
              const existing = current.get(id);
              if (existing === undefined) {
                return [undefined, current] as const;
              }
              const config = mergeMarimoConfig(existing, request.config);
              const next = new Map(current);
              next.set(id, config);
              return [config, next] as const;
            }).pipe(
              Effect.flatMap((config) =>
                config === undefined
                  ? Effect.die(`Config not found for ${request.notebookUri}`)
                  : Effect.succeed(config),
              ),
            );
          }

          return yield* Effect.die(
            `Unexpected marimo command: ${request.kind}`,
          );
        }),
      });

      return Layer.merge(
        NotebookSessionResources.layer.pipe(
          Layer.provideMerge(runtimeLayer),
          Layer.provideMerge(NotebookDocumentSessions.layer),
          Layer.provideMerge(
            VsCodeTest.layerWith({ initialDocuments: [...documents.values()] }),
          ),
        ),
        Layer.succeed(Server, {
          configs,
          documents,
          nextGetPauses,
          nextUpdatePauses,
        }),
      );
    }),
  );

const it = EffectTest.make(
  layerWith(
    new Map([
      [NOTEBOOK_URI, AUTORUN_CONFIG],
      [NOTEBOOK_URI_1, AUTORUN_CONFIG],
      [NOTEBOOK_URI_2, AUTO_RELOAD_CONFIG],
    ]),
  ),
);

/** Pauses the next request in `queue` until the returned release runs. */
const pauseNext = Effect.fn(function* (
  select: (server: Server["Service"]) => Queue.Queue<RequestGate>,
) {
  const server = yield* Server;
  const started = yield* Latch.make();
  const release = yield* Latch.make();
  yield* Queue.offer(select(server), { started, release });
  return {
    started: started.await,
    release: release.open.pipe(Effect.asVoid),
  };
});
const pauseNextGet = pauseNext((server) => server.nextGetPauses);
const pauseNextUpdate = pauseNext((server) => server.nextUpdatePauses);

const setConfig = Effect.fn(function* (
  notebookId: NotebookId,
  config: MarimoConfig,
) {
  const server = yield* Server;
  yield* Ref.update(server.configs, (current) => {
    const next = new Map(current);
    next.set(notebookId, config);
    return next;
  });
});

const documentFor = Effect.fn(function* (notebookId: NotebookId) {
  const server = yield* Server;
  return Option.getOrThrow(
    Option.fromNullishOr(server.documents.get(notebookId)),
  );
});

/** Opens a new document at the same URI and waits for it to become active. */
const replaceDocument = Effect.fn(function* (notebookId: NotebookId) {
  const server = yield* Server;
  const vscode = yield* VsCodeTest.Service;
  const sessions = yield* NotebookDocumentSessions.Service;
  const replacement = VsCodeTest.createTestNotebookDocument(
    VsCodeTest.Uri.parse(notebookId),
  );
  yield* vscode.openNotebook(replacement);
  yield* vscode.setActiveNotebookEditor(
    Option.some(VsCodeTest.createTestNotebookEditor(replacement)),
  );
  yield* sessions.active.pipe(
    Stream.filter(Option.exists((session) => session.document === replacement)),
    Stream.runHead,
  );
  server.documents.set(notebookId, replacement);
  return replacement;
});

const closeDocument = (document: vscode.NotebookDocument) =>
  DocumentLifecycle.transition(document, "closed");

const inNotebook = <A, E, R>(
  notebookUri: NotebookId,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sessions = yield* NotebookDocumentSessions.Service;
    const resources = yield* NotebookSessionResources.Service;
    const session = sessions.current(notebookUri);
    Vitest.assert(Option.isSome(session));
    return yield* resources
      .runScoped(session.value, effect)
      .pipe(Scope.provide(session.value.scope));
  });

const getConfig = (notebookUri: NotebookId) =>
  inNotebook(
    notebookUri,
    NotebookConfiguration.Service.pipe(
      Effect.flatMap((configuration) => configuration.get),
    ),
  );

const updateConfig = (
  notebookUri: NotebookId,
  partialConfig: Record<string, unknown>,
) =>
  inNotebook(
    notebookUri,
    NotebookConfiguration.Service.pipe(
      Effect.flatMap((configuration) => configuration.update(partialConfig)),
    ),
  );

const invalidateConfig = (notebookUri: NotebookId) =>
  inNotebook(
    notebookUri,
    NotebookConfiguration.Service.pipe(
      Effect.flatMap((configuration) => configuration.invalidate),
    ),
  );

const configurationChanges = (
  notebookUri: NotebookId,
  take: number,
  ready: Deferred.Deferred<void>,
) =>
  inNotebook(
    notebookUri,
    NotebookConfiguration.Service.pipe(
      Effect.flatMap((configuration) =>
        configuration.changes.pipe(
          Stream.tap((value) =>
            Option.isSome(value)
              ? Deferred.succeed(ready, undefined)
              : Effect.void,
          ),
          Stream.take(take),
          Stream.runCollect,
        ),
      ),
    ),
  );

const requestCount = Effect.fn(function* (kind: string) {
  const marimo = yield* MarimoClientTest.Service;
  return (yield* marimo.commands).filter((request) => request.kind === kind)
    .length;
});

Vitest.describe("NotebookConfiguration", () => {
  it.effect(
    "fetches once and caches within a document session",
    Effect.fn(function* () {
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);
      yield* setConfig(NOTEBOOK_URI, marimoConfigFixture({}));
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);
    }),
  );

  it.effect(
    "shares an in-flight lookup",
    Effect.fn(function* () {
      const pause = yield* pauseNextGet;
      const lookups = yield* Effect.forkChild(
        Effect.all([getConfig(NOTEBOOK_URI), getConfig(NOTEBOOK_URI)], {
          concurrency: "unbounded",
        }),
      );

      yield* pause.started;
      Vitest.expect(yield* requestCount("get-configuration")).toBe(1);
      yield* pause.release;
      Vitest.expect(yield* Fiber.join(lookups)).toEqual([
        AUTORUN_CONFIG,
        AUTORUN_CONFIG,
      ]);
    }),
  );

  it.effect(
    "updates the cached value and publishes changes",
    Effect.fn(function* () {
      const ready = yield* Deferred.make<void>();
      const collected = yield* Effect.forkChild(
        configurationChanges(NOTEBOOK_URI, 4, ready),
      );
      yield* Deferred.await(ready);

      yield* updateConfig(NOTEBOOK_URI, {
        runtime: { on_cell_change: "lazy" },
      });
      yield* updateConfig(NOTEBOOK_URI, {
        runtime: { on_cell_change: "autorun" },
      });

      const changes = yield* Fiber.join(collected);
      Vitest.expect(changes[0]?._tag).toBe("None");
      Vitest.expect(changes[1]).toEqual(Option.some(AUTORUN_CONFIG));
      Vitest.expect(changes[2]).toEqual(Option.some(LAZY_CONFIG));
      Vitest.expect(changes[3]).toEqual(Option.some(AUTORUN_CONFIG));
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);
    }),
  );

  it.effect(
    "does not publish a lookup superseded by an update",
    Effect.fn(function* () {
      const pause = yield* pauseNextGet;

      yield* inNotebook(
        NOTEBOOK_URI,
        NotebookConfiguration.Service.pipe(
          Effect.flatMap((configuration) =>
            Effect.gen(function* () {
              const stale = yield* configuration.get.pipe(Effect.forkChild);
              yield* pause.started;

              Vitest.expect(
                yield* configuration.update({
                  runtime: { on_cell_change: "lazy" },
                }),
              ).toEqual(LAZY_CONFIG);
              yield* pause.release;
              Vitest.expect(yield* Fiber.join(stale)).toEqual(AUTORUN_CONFIG);

              const current = yield* configuration.changes.pipe(
                Stream.take(1),
                Stream.runHead,
              );
              Vitest.expect(Option.getOrThrow(current)).toEqual(
                Option.some(LAZY_CONFIG),
              );
              Vitest.expect(yield* configuration.get).toEqual(LAZY_CONFIG);
            }),
          ),
        ),
      );
    }),
  );

  it.effect(
    "serializes configuration updates",
    Effect.fn(function* () {
      const pause = yield* pauseNextUpdate;
      const first = yield* updateConfig(NOTEBOOK_URI, {
        runtime: { on_cell_change: "lazy" },
      }).pipe(Effect.forkChild);
      yield* pause.started;
      const second = yield* updateConfig(NOTEBOOK_URI, {
        runtime: {
          on_cell_change: "autorun",
          auto_reload: "autorun",
        },
      }).pipe(Effect.forkChild({ startImmediately: true }));
      Vitest.expect(yield* requestCount("update-configuration")).toBe(1);

      yield* pause.release;
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      Vitest.expect(yield* requestCount("update-configuration")).toBe(2);
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTO_RELOAD_CONFIG);
    }),
  );

  it.effect(
    "does not recache a lookup invalidated while in flight",
    Effect.fn(function* () {
      const pause = yield* pauseNextGet;
      const pending = yield* Effect.forkChild(getConfig(NOTEBOOK_URI));
      yield* pause.started;
      yield* invalidateConfig(NOTEBOOK_URI);
      yield* setConfig(NOTEBOOK_URI, LAZY_CONFIG);
      yield* pause.release;

      Vitest.expect(yield* Fiber.join(pending)).toEqual(AUTORUN_CONFIG);
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(LAZY_CONFIG);
    }),
  );

  it.effect(
    "evicts resources when a document session ends",
    Effect.fn(function* () {
      const vscode = yield* VsCodeTest.Service;
      const document = yield* documentFor(NOTEBOOK_URI);
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);

      yield* vscode.closeNotebook(document);
      yield* setConfig(NOTEBOOK_URI, LAZY_CONFIG);
      yield* replaceDocument(NOTEBOOK_URI);

      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(LAZY_CONFIG);
    }),
  );

  it.effect(
    "ignores a delayed close from a replaced document",
    Effect.fn(function* () {
      const first = yield* documentFor(NOTEBOOK_URI);
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);

      yield* setConfig(NOTEBOOK_URI, LAZY_CONFIG);
      yield* replaceDocument(NOTEBOOK_URI);
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(LAZY_CONFIG);

      yield* setConfig(NOTEBOOK_URI, AUTORUN_CONFIG);
      yield* closeDocument(first);
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(LAZY_CONFIG);
    }),
  );

  it.effect(
    "isolates concurrent notebook sessions",
    Effect.fn(function* () {
      Vitest.expect(yield* getConfig(NOTEBOOK_URI_1)).toEqual(AUTORUN_CONFIG);
      Vitest.expect(yield* getConfig(NOTEBOOK_URI_2)).toEqual(
        AUTO_RELOAD_CONFIG,
      );

      yield* updateConfig(NOTEBOOK_URI_1, {
        runtime: { on_cell_change: "lazy" },
      });
      Vitest.expect(yield* getConfig(NOTEBOOK_URI_1)).toEqual(LAZY_CONFIG);
      Vitest.expect(yield* getConfig(NOTEBOOK_URI_2)).toEqual(
        AUTO_RELOAD_CONFIG,
      );
    }),
  );
});
