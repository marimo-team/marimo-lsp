import * as Vitest from "@effect/vitest";
import {
  Context,
  Effect,
  Fiber,
  Latch,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";

import * as ConfigContextManager from "../../src/config/ConfigContextManager.ts";
import * as NotebookDocumentSessions from "../../src/notebook/NotebookDocumentSessions.ts";
import * as NotebookSessionResources from "../../src/notebook/NotebookSessionResources.ts";
import * as NotebookRuntimeTest from "../fake/NotebookRuntime.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import { marimoConfigFixture, notebookId } from "../lib/branded.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
const NOTEBOOK_URI_2 = notebookId("file:///test/notebook-2.py");

const firstDocument = VsCodeTest.createTestNotebookDocument(
  VsCodeTest.Uri.parse(NOTEBOOK_URI),
);
const secondDocument = VsCodeTest.createTestNotebookDocument(
  VsCodeTest.Uri.parse(NOTEBOOK_URI_2),
);

const configurations = new Map([
  [
    NOTEBOOK_URI,
    marimoConfigFixture({
      runtime: { on_cell_change: "lazy", auto_reload: "autorun" },
    }),
  ],
  [
    NOTEBOOK_URI_2,
    marimoConfigFixture({
      runtime: { on_cell_change: "autorun", auto_reload: "lazy" },
    }),
  ],
]);

interface ContextWrite {
  readonly key: string;
  readonly value: unknown;
}

/** Context key writes observed so far, plus the gate on the first write. */
class ContextWrites extends Context.Service<
  ContextWrites,
  {
    readonly writes: Effect.Effect<ReadonlyArray<ContextWrite>>;
    readonly await: (write: ContextWrite) => Effect.Effect<void>;
    readonly firstWriteStarted: Latch.Latch;
    readonly releaseFirstWrite: Latch.Latch;
  }
>()("@marimo/test/ConfigContextManager/ContextWrites") {}

const layerWith = (options: { readonly blockFirstWrite: boolean }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const writes = yield* SubscriptionRef.make<ReadonlyArray<ContextWrite>>(
        [],
      );
      const firstWriteStarted = yield* Latch.make();
      const releaseFirstWrite = yield* Latch.make();

      const vscodeLayer = VsCodeTest.layerWith(
        { initialDocuments: [firstDocument, secondDocument] },
        {
          commands: {
            setContext: (key, value) =>
              Effect.gen(function* () {
                if (
                  options.blockFirstWrite &&
                  key === "marimo.config.runtime.on_cell_change" &&
                  value === "lazy"
                ) {
                  yield* firstWriteStarted.open;
                  yield* releaseFirstWrite.await;
                }
                yield* SubscriptionRef.update(writes, (current) => [
                  ...current,
                  { key, value },
                ]);
              }),
          },
        },
      );
      const runtimeLayer = NotebookRuntimeTest.layerWith({
        send: Effect.fn(function* (request) {
          if (request.kind !== "get-configuration") {
            return yield* Effect.die(`Unexpected command: ${request.kind}`);
          }
          const config = configurations.get(notebookId(request.notebookUri));
          if (config === undefined) {
            return yield* Effect.die(
              `Missing configuration for ${request.notebookUri}`,
            );
          }
          return { config };
        }),
      });
      const manager = ConfigContextManager.layer.pipe(
        Layer.provide(
          NotebookSessionResources.layer.pipe(Layer.provide(runtimeLayer)),
        ),
        Layer.provide(
          NotebookDocumentSessions.layer.pipe(Layer.provide(vscodeLayer)),
        ),
        Layer.provideMerge(vscodeLayer),
      );

      const has =
        (write: ContextWrite) => (current: ReadonlyArray<ContextWrite>) =>
          current.some(
            ({ key, value }) => key === write.key && value === write.value,
          );

      return Layer.merge(
        manager,
        Layer.succeed(ContextWrites, {
          writes: SubscriptionRef.get(writes),
          await: (write) =>
            SubscriptionRef.changes(writes).pipe(
              Stream.filter(has(write)),
              Stream.runHead,
              Effect.asVoid,
            ),
          firstWriteStarted,
          releaseFirstWrite,
        }),
      );
    }),
  );

/** Activates the document and waits until the manager has queued its config. */
const activate = Effect.fn("activate")(function* (
  document: vscode.NotebookDocument,
) {
  const vscode = yield* VsCodeTest.Service;
  const manager = yield* ConfigContextManager.Service;
  const published = yield* manager.desiredChanges.pipe(
    Stream.filter(Option.exists((session) => session.document === document)),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
  yield* vscode.setActiveNotebookEditor(
    Option.some(VsCodeTest.createTestNotebookEditor(document)),
  );
  yield* Fiber.join(published);
});

const AUTO_RELOAD = "marimo.config.runtime.auto_reload";
const ON_CELL_CHANGE = "marimo.config.runtime.on_cell_change";

Vitest.describe("ConfigContextManager", () => {
  const it = EffectTest.make(layerWith({ blockFirstWrite: false }));

  it.effect(
    "mirrors the active session configuration into context keys",
    Effect.fn(function* () {
      const context = yield* ContextWrites;
      yield* context.await({ key: AUTO_RELOAD, value: "off" });

      const initial = yield* context.writes;
      Vitest.expect(initial).toContainEqual({
        key: ON_CELL_CHANGE,
        value: "autorun",
      });
      Vitest.expect(initial).toContainEqual({ key: AUTO_RELOAD, value: "off" });

      yield* activate(firstDocument);
      yield* context.await({ key: AUTO_RELOAD, value: "autorun" });
      const updated = yield* context.writes;
      Vitest.expect(updated).toContainEqual({
        key: ON_CELL_CHANGE,
        value: "lazy",
      });
      Vitest.expect(updated).toContainEqual({
        key: AUTO_RELOAD,
        value: "autorun",
      });
    }),
  );

  Vitest.describe("when an earlier context write is blocked", () => {
    const it = EffectTest.make(layerWith({ blockFirstWrite: true }));

    it.effect(
      "keeps context writes ordered when the active session changes",
      Effect.fn(function* () {
        const context = yield* ContextWrites;
        yield* context.await({ key: AUTO_RELOAD, value: "off" });
        yield* activate(firstDocument);
        yield* context.firstWriteStarted.await;

        yield* activate(secondDocument);
        yield* context.releaseFirstWrite.open;
        yield* context.await({ key: AUTO_RELOAD, value: "lazy" });

        const latest = new Map(
          (yield* context.writes).map(({ key, value }) => [key, value]),
        );
        Vitest.expect(latest.get(ON_CELL_CHANGE)).toBe("autorun");
        Vitest.expect(latest.get(AUTO_RELOAD)).toBe("lazy");
      }),
    );
  });
});
