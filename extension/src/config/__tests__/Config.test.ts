import * as Vitest from "@effect/vitest";
import { Effect, Layer, Result } from "effect";

import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import * as Config from "../Config.ts";

const configLayer = Layer.empty.pipe(
  Layer.provideMerge(Config.layer),
  Layer.provide(VsCodeTest.layer),
);
const configIt = EffectTest.make(configLayer);

configIt.effect(
  "should build",
  Effect.fn(function* () {
    const api = yield* Config.Service;
    Vitest.expect(api).toBeDefined();
  }),
);

Vitest.it.effect(
  "defaults to the WASM language server without the VS Code API",
  Effect.fn(function* () {
    const config = yield* Config.Service.pipe(Effect.provide(Config.layer));

    Vitest.expect(yield* config.lsp.server).toEqual({ _tag: "Wasm" });
  }),
);

Vitest.it.effect(
  "defaults to WASM when no language-server setting is explicit",
  Effect.fn(function* () {
    Vitest.expect(
      yield* Config.resolveMarimoLspServer({
        server: undefined,
        path: [],
      }),
    ).toEqual({ _tag: "Wasm" });
  }),
);

Vitest.it.effect(
  "resolves every explicit language-server mode",
  Effect.fn(function* () {
    const wasm = yield* Config.resolveMarimoLspServer({
      server: "wasm",
      path: [],
    });
    const python = yield* Config.resolveMarimoLspServer({
      server: "python",
      path: [],
    });
    const custom = yield* Config.resolveMarimoLspServer({
      server: "custom",
      path: ["/opt/marimo-lsp", "--stdio"],
    });

    Vitest.expect([wasm, python, custom]).toEqual([
      { _tag: "Wasm" },
      { _tag: "Python" },
      {
        _tag: "Custom",
        command: ["/opt/marimo-lsp", "--stdio"],
      },
    ]);
  }),
);

Vitest.it.effect(
  "ignores the custom path unless custom mode is selected",
  Effect.fn(function* () {
    Vitest.expect(
      yield* Config.resolveMarimoLspServer({
        server: undefined,
        path: ["/legacy/marimo-lsp"],
      }),
    ).toEqual({ _tag: "Wasm" });
  }),
);

Vitest.it.effect(
  "rejects custom mode without a command before it reaches MarimoClient",
  Effect.fn(function* () {
    const result = yield* Effect.result(
      Config.resolveMarimoLspServer({
        server: "custom",
        path: [],
      }),
    );

    Vitest.assert(Result.isFailure(result));
    Vitest.expect(result.failure).toMatchObject({
      _tag: "InvalidMarimoLspConfiguration",
      setting: "marimo.lsp.path",
    });
  }),
);

Vitest.it.effect(
  "rejects an unsupported language-server mode at the configuration boundary",
  Effect.fn(function* () {
    const result = yield* Effect.result(
      Config.resolveMarimoLspServer({
        server: "auto",
        path: [],
      }),
    );

    Vitest.assert(Result.isFailure(result));
    Vitest.expect(result.failure).toMatchObject({
      _tag: "InvalidMarimoLspConfiguration",
      setting: "marimo.lsp.server",
    });
  }),
);

Vitest.it.effect(
  "rejects a custom command with a blank executable",
  Effect.fn(function* () {
    const result = yield* Effect.result(
      Config.resolveMarimoLspServer({
        server: "custom",
        path: ["   ", "--stdio"],
      }),
    );

    Vitest.assert(Result.isFailure(result));
    Vitest.expect(result.failure).toMatchObject({
      _tag: "InvalidMarimoLspConfiguration",
      setting: "marimo.lsp.path",
    });
  }),
);
