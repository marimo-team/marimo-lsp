import { Context, Effect, Latch, Layer, Option, Queue, Ref } from "effect";
import type * as vscode from "vscode";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import {
  makeTestNotebookRuntime,
  type TestCommand,
} from "../../__tests__/__utils__/TestMarimoClient.ts";
import { mergeMarimoConfig, notebookId } from "../../lib/__tests__/branded.ts";
import * as NotebookDocumentSessions from "../../notebook/NotebookDocumentSessions.ts";
import * as NotebookSessionResources from "../../notebook/NotebookSessionResources.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { MarimoConfig } from "../../types.ts";

export interface PausedRequest {
  readonly started: Effect.Effect<void>;
  readonly release: Effect.Effect<void>;
}

interface RequestGate {
  readonly started: Latch.Latch;
  readonly release: Latch.Latch;
}

export interface Interface {
  readonly vscode: TestVsCode.Interface;
  readonly requests: Effect.Effect<ReadonlyArray<TestCommand>>;
  readonly document: (
    notebookId: NotebookId,
  ) => Option.Option<vscode.NotebookDocument>;
  readonly setConfig: (
    notebookId: NotebookId,
    config: MarimoConfig,
  ) => Effect.Effect<void>;
  readonly pauseNextGet: Effect.Effect<PausedRequest>;
  readonly pauseNextUpdate: Effect.Effect<PausedRequest>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/NotebookConfiguration",
) {}

const enqueuePause = Effect.fn(function* (queue: Queue.Queue<RequestGate>) {
  const started = yield* Latch.make();
  const release = yield* Latch.make();
  yield* Queue.offer(queue, { started, release });
  return {
    started: started.await,
    release: release.open.pipe(Effect.asVoid),
  } satisfies PausedRequest;
});

const pauseAt = Effect.fn(function* (queue: Queue.Queue<RequestGate>) {
  const gate = yield* Queue.poll(queue);
  if (Option.isNone(gate)) return;
  yield* gate.value.started.open;
  yield* gate.value.release.await;
});

export const layerWith = (
  initialConfigs: ReadonlyMap<NotebookId, MarimoConfig>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const configs = yield* Ref.make(new Map(initialConfigs));
      const requests = yield* Ref.make<ReadonlyArray<TestCommand>>([]);
      const nextGetPauses = yield* Queue.unbounded<RequestGate>();
      const nextUpdatePauses = yield* Queue.unbounded<RequestGate>();
      const documents = new Map(
        Array.from(
          initialConfigs.keys(),
          (notebookId) =>
            [
              notebookId,
              TestVsCode.createTestNotebookDocument(
                TestVsCode.Uri.parse(notebookId),
              ),
            ] as const,
        ),
      );

      const vscodeLayer = TestVsCode.layerWith({
        initialDocuments: [...documents.values()],
      });
      const runtimeLayer = makeTestNotebookRuntime({
        send: Effect.fn(function* (request) {
          yield* Ref.update(requests, (current) => [...current, request]);

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
      const documentSessions = NotebookDocumentSessions.layer.pipe(
        Layer.provide(vscodeLayer),
      );
      const sessionResources = NotebookSessionResources.layer.pipe(
        Layer.provide(documentSessions),
        Layer.provide(runtimeLayer),
      );
      const environment = Layer.mergeAll(
        vscodeLayer,
        documentSessions,
        sessionResources,
      );
      const fixture = Layer.effect(
        Service,
        Effect.gen(function* () {
          const vscode = yield* TestVsCode.Service;
          return Service.of({
            vscode,
            requests: Ref.get(requests),
            document: (notebookId) =>
              Option.fromNullishOr(documents.get(notebookId)),
            setConfig: (notebookId, config) =>
              Ref.update(configs, (current) => {
                const next = new Map(current);
                next.set(notebookId, config);
                return next;
              }),
            pauseNextGet: enqueuePause(nextGetPauses),
            pauseNextUpdate: enqueuePause(nextUpdatePauses),
          });
        }),
      ).pipe(Layer.provide(environment));

      return Layer.merge(environment, fixture);
    }),
  );
