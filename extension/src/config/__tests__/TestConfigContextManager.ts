import {
  Context,
  Data,
  Effect,
  Fiber,
  Latch,
  Layer,
  Option,
  Ref,
  Stream,
} from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import {
  marimoConfigFixture,
  notebookId,
} from "../../lib/__tests__/branded.ts";
import * as NotebookDocumentSessions from "../../notebook/NotebookDocumentSessions.ts";
import * as NotebookSessionResources from "../../notebook/NotebookSessionResources.ts";
import * as ConfigContextManager from "../ConfigContextManager.ts";

export const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
export const NOTEBOOK_URI_2 = notebookId("file:///test/notebook-2.py");

export type Scenario = Data.TaggedEnum<{
  Normal: {};
  BlockFirstWrite: {};
}>;
export const Scenario = Data.taggedEnum<Scenario>();

export interface ContextWrite {
  readonly key: string;
  readonly value: unknown;
}

export interface Interface {
  readonly writes: Effect.Effect<ReadonlyArray<ContextWrite>>;
  readonly defaultsWritten: Effect.Effect<void>;
  readonly firstConfigurationWritten: Effect.Effect<void>;
  readonly firstWriteStarted: Effect.Effect<void>;
  readonly secondConfigurationWritten: Effect.Effect<void>;
  readonly releaseFirstWrite: Effect.Effect<void>;
  readonly activateFirst: Effect.Effect<void>;
  readonly activateSecond: Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/ConfigContextManager",
) {}

export const layerWith = (scenario: Scenario) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const firstDocument = TestVsCode.createTestNotebookDocument(
        TestVsCode.Uri.parse(NOTEBOOK_URI),
      );
      const secondDocument = TestVsCode.createTestNotebookDocument(
        TestVsCode.Uri.parse(NOTEBOOK_URI_2),
      );
      const writes = yield* Ref.make<ReadonlyArray<ContextWrite>>([]);
      const defaultsWritten = yield* Latch.make();
      const firstConfigurationWritten = yield* Latch.make();
      const firstWriteStarted = yield* Latch.make();
      const releaseFirstWrite = yield* Latch.make();
      const secondConfigurationWritten = yield* Latch.make();

      const vscodeLayer = TestVsCode.layerWith(
        {
          initialDocuments: [firstDocument, secondDocument],
        },
        {
          commands: {
            setContext: (key, value) =>
              Effect.gen(function* () {
                if (
                  Scenario.$is("BlockFirstWrite")(scenario) &&
                  key === "marimo.config.runtime.on_cell_change" &&
                  value === "lazy"
                ) {
                  yield* firstWriteStarted.open;
                  yield* releaseFirstWrite.await;
                }
                yield* Ref.update(writes, (current) => [
                  ...current,
                  { key, value },
                ]);
                if (
                  key === "marimo.config.runtime.auto_reload" &&
                  value === "off"
                ) {
                  yield* defaultsWritten.open;
                }
                if (
                  key === "marimo.config.runtime.auto_reload" &&
                  value === "autorun"
                ) {
                  yield* firstConfigurationWritten.open;
                }
                if (
                  key === "marimo.config.runtime.auto_reload" &&
                  value === "lazy"
                ) {
                  yield* secondConfigurationWritten.open;
                }
              }),
          },
        },
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
      const runtimeLayer = makeTestNotebookRuntime({
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
      const documentSessions = NotebookDocumentSessions.layer.pipe(
        Layer.provide(vscodeLayer),
      );
      const resources = NotebookSessionResources.layer.pipe(
        Layer.provide(runtimeLayer),
      );
      const manager = ConfigContextManager.layer.pipe(
        Layer.provide(resources),
        Layer.provide(documentSessions),
        Layer.provide(vscodeLayer),
      );
      const environment = Layer.merge(manager, vscodeLayer);
      const fixture = Layer.effect(
        Service,
        Effect.gen(function* () {
          const vscode = yield* TestVsCode.Service;
          const manager = yield* ConfigContextManager.Service;
          const activate = (document: typeof firstDocument) =>
            Effect.gen(function* () {
              const published = yield* manager.desiredChanges.pipe(
                Stream.filter(
                  Option.exists((session) => session.document === document),
                ),
                Stream.runHead,
                Effect.forkChild({ startImmediately: true }),
              );
              yield* vscode.setActiveNotebookEditor(
                Option.some(TestVsCode.createTestNotebookEditor(document)),
              );
              yield* Fiber.join(published);
            });
          return Service.of({
            writes: Ref.get(writes),
            defaultsWritten: defaultsWritten.await,
            firstConfigurationWritten: firstConfigurationWritten.await,
            firstWriteStarted: firstWriteStarted.await,
            secondConfigurationWritten: secondConfigurationWritten.await,
            releaseFirstWrite: releaseFirstWrite.open.pipe(Effect.asVoid),
            activateFirst: activate(firstDocument),
            activateSecond: activate(secondDocument),
          });
        }),
      ).pipe(Layer.provide(environment));

      return Layer.merge(environment, fixture);
    }),
  );

export const layer = layerWith(Scenario.Normal());
