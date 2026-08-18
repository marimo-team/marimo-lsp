import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Option, Ref, Schema } from "effect";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
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
import { NotebookEditorRegistry } from "../../notebook/NotebookEditorRegistry.ts";
import { NotebookSessionResources } from "../../notebook/NotebookSessionResources.ts";
import * as Api from "../../schemas/Models.gen.ts";
import { ConfigContextManagerLive } from "../ConfigContextManager.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");

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
    execute: Effect.fn(function* (request) {
      if (request.method !== "get-configuration") {
        return yield* Effect.die(`Unexpected method: ${request.method}`);
      }
      yield* Schema.decodeUnknownEffect(Api.GetConfigurationPayload)(
        request.params,
      );
      return { config };
    }),
  });
  const documentSessions = NotebookDocumentSessions.layer.pipe(
    Layer.provide(vscode.layer),
  );
  const editors = NotebookEditorRegistry.layer.pipe(
    Layer.provide(TestTelemetryLive),
    Layer.provide(vscode.layer),
  );
  const resources = NotebookSessionResources.layer.pipe(
    Layer.provide(documentSessions),
    Layer.provide(runtime),
  );
  return {
    vscode,
    document,
    contextWrites,
    wroteDefaults,
    wroteConfiguration,
    layer: ConfigContextManagerLive.pipe(
      Layer.provide(resources),
      Layer.provide(documentSessions),
      Layer.provide(editors),
      Layer.provide(vscode.layer),
    ),
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
