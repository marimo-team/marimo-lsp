import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Option, Ref } from "effect";

import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
  Uri,
} from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import {
  marimoConfigFixture,
  notebookId,
} from "../../lib/__tests__/branded.ts";
import { NotebookDocumentSessions } from "../../notebook/NotebookDocumentSessions.ts";
import { NotebookSessionResources } from "../../notebook/NotebookSessionResources.ts";
import { ConfigContextManagerLive } from "../ConfigContextManager.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
const NOTEBOOK_URI_2 = notebookId("file:///test/notebook-2.py");

const managerLayer = (
  vscode: TestVsCode,
  runtime: ReturnType<typeof makeTestNotebookRuntime>,
) => {
  const documentSessions = NotebookDocumentSessions.layer.pipe(
    Layer.provide(vscode.layer),
  );
  const resources = NotebookSessionResources.layer.pipe(Layer.provide(runtime));
  return ConfigContextManagerLive.pipe(
    Layer.provide(resources),
    Layer.provide(documentSessions),
    Layer.provide(vscode.layer),
  );
};

const withTestCtx = Effect.fn(function* () {
  const document = createTestNotebookDocument(Uri.parse(NOTEBOOK_URI));
  const contextWrites = yield* Ref.make<
    ReadonlyArray<{ key: string; value: unknown }>
  >([]);
  const wroteDefaults = yield* Deferred.make<void>();
  const wroteConfiguration = yield* Deferred.make<void>();
  const vscode = yield* TestVsCode.make({
    initialDocuments: [document],
    commands: {
      setContext(key, value) {
        const signal =
          key === "marimo.config.runtime.auto_reload" && value === "off"
            ? Deferred.succeed(wroteDefaults, undefined)
            : key === "marimo.config.runtime.auto_reload" && value === "autorun"
              ? Deferred.succeed(wroteConfiguration, undefined)
              : Effect.void;
        return Ref.update(contextWrites, (writes) => [
          ...writes,
          { key, value },
        ]).pipe(Effect.andThen(signal), Effect.asVoid);
      },
    },
  });
  const config = marimoConfigFixture({
    runtime: { on_cell_change: "lazy", auto_reload: "autorun" },
  });
  const runtime = makeTestNotebookRuntime({
    send: Effect.fn(function* (request) {
      if (request.kind !== "get-configuration") {
        return yield* Effect.die(`Unexpected command: ${request.kind}`);
      }
      return { config };
    }),
  });
  return {
    vscode,
    document,
    contextWrites,
    wroteDefaults,
    wroteConfiguration,
    layer: managerLayer(vscode, runtime),
  };
});

it.effect("mirrors the active session configuration into context keys", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx();
    yield* Layer.build(ctx.layer);
    yield* Deferred.await(ctx.wroteDefaults);

    const initial = yield* Ref.get(ctx.contextWrites);
    expect(initial).toContainEqual({
      key: "marimo.config.runtime.on_cell_change",
      value: "autorun",
    });
    expect(initial).toContainEqual({
      key: "marimo.config.runtime.auto_reload",
      value: "off",
    });

    yield* ctx.vscode.setActiveNotebookEditor(
      Option.some(createTestNotebookEditor(ctx.document)),
    );
    yield* Deferred.await(ctx.wroteConfiguration);

    const updated = yield* Ref.get(ctx.contextWrites);
    expect(updated).toContainEqual({
      key: "marimo.config.runtime.on_cell_change",
      value: "lazy",
    });
    expect(updated).toContainEqual({
      key: "marimo.config.runtime.auto_reload",
      value: "autorun",
    });
  }),
);

it.effect("keeps context writes ordered when the active session changes", () =>
  Effect.gen(function* () {
    const firstDocument = createTestNotebookDocument(Uri.parse(NOTEBOOK_URI));
    const secondDocument = createTestNotebookDocument(
      Uri.parse(NOTEBOOK_URI_2),
    );
    const writes: Array<{ key: string; value: unknown }> = [];

    let releaseFirstWrite: () => void = () => undefined;
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let signalFirstWriteStarted: () => void = () => undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWriteStarted = resolve;
    });
    let signalSecondConfigurationLoaded: () => void = () => undefined;
    const secondConfigurationLoaded = new Promise<void>((resolve) => {
      signalSecondConfigurationLoaded = resolve;
    });
    let signalSecondConfigurationWritten: () => void = () => undefined;
    const secondConfigurationWritten = new Promise<void>((resolve) => {
      signalSecondConfigurationWritten = resolve;
    });

    const vscode = yield* TestVsCode.make({
      initialDocuments: [firstDocument, secondDocument],
      commands: {
        setContext: (key, value) =>
          Effect.promise(async () => {
            if (
              key === "marimo.config.runtime.on_cell_change" &&
              value === "lazy"
            ) {
              signalFirstWriteStarted();
              await firstWriteReleased;
            }
            writes.push({ key, value });
            if (
              key === "marimo.config.runtime.auto_reload" &&
              value === "lazy"
            ) {
              signalSecondConfigurationWritten();
            }
          }),
      },
    });
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
    const runtime = makeTestNotebookRuntime({
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
        if (request.notebookUri === NOTEBOOK_URI_2) {
          signalSecondConfigurationLoaded();
        }
        return { config };
      }),
    });

    yield* Layer.build(managerLayer(vscode, runtime));
    yield* vscode.setActiveNotebookEditor(
      Option.some(createTestNotebookEditor(firstDocument)),
    );
    yield* Effect.promise(() => firstWriteStarted);

    yield* vscode.setActiveNotebookEditor(
      Option.some(createTestNotebookEditor(secondDocument)),
    );
    yield* Effect.promise(() => secondConfigurationLoaded);
    yield* Effect.yieldNow;
    yield* Effect.sync(releaseFirstWrite);
    yield* Effect.promise(() => secondConfigurationWritten);

    const latest = new Map(writes.map(({ key, value }) => [key, value]));
    expect(latest.get("marimo.config.runtime.on_cell_change")).toBe("autorun");
    expect(latest.get("marimo.config.runtime.auto_reload")).toBe("lazy");
  }),
);
