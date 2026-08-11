import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { Config, resolveMarimoLspServer } from "../../config/Config.ts";

const ConfigLive = Layer.empty.pipe(
  Layer.provideMerge(Config.layer),
  Layer.provide(TestVsCode.layer),
);

it.layer(ConfigLive)("Config", (it) => {
  it.effect(
    "should build",
    Effect.fn(function* () {
      const api = yield* Config;
      expect(api).toBeDefined();
    }),
  );
});

it.effect(
  "defaults to the WASM language server without the VS Code API",
  Effect.fn(function* () {
    const config = yield* Config.pipe(Effect.provide(Config.layer));

    expect(yield* config.lsp.server).toEqual({ _tag: "Wasm" });
  }),
);

it.effect(
  "defaults to WASM when no language-server setting is explicit",
  Effect.fn(function* () {
    expect(
      yield* resolveMarimoLspServer({
        server: undefined,
        path: [],
      }),
    ).toEqual({ _tag: "Wasm" });
  }),
);

it.effect(
  "resolves every explicit language-server mode",
  Effect.fn(function* () {
    const wasm = yield* resolveMarimoLspServer({
      server: "wasm",
      path: [],
    });
    const python = yield* resolveMarimoLspServer({
      server: "python",
      path: [],
    });
    const custom = yield* resolveMarimoLspServer({
      server: "custom",
      path: ["/opt/marimo-lsp", "--stdio"],
    });

    expect([wasm, python, custom]).toEqual([
      { _tag: "Wasm" },
      { _tag: "Python" },
      {
        _tag: "Custom",
        command: ["/opt/marimo-lsp", "--stdio"],
      },
    ]);
  }),
);

it.effect(
  "ignores the custom path unless custom mode is selected",
  Effect.fn(function* () {
    expect(
      yield* resolveMarimoLspServer({
        server: undefined,
        path: ["/legacy/marimo-lsp"],
      }),
    ).toEqual({ _tag: "Wasm" });
  }),
);

it.effect(
  "rejects custom mode without a command before it reaches MarimoClient",
  Effect.fn(function* () {
    const result = yield* Effect.result(
      resolveMarimoLspServer({
        server: "custom",
        path: [],
      }),
    );

    assert(Result.isFailure(result));
    expect(result.failure).toMatchObject({
      _tag: "InvalidMarimoLspConfiguration",
      setting: "marimo.lsp.path",
    });
  }),
);

it.effect(
  "rejects an unsupported language-server mode at the configuration boundary",
  Effect.fn(function* () {
    const result = yield* Effect.result(
      resolveMarimoLspServer({
        server: "auto",
        path: [],
      }),
    );

    assert(Result.isFailure(result));
    expect(result.failure).toMatchObject({
      _tag: "InvalidMarimoLspConfiguration",
      setting: "marimo.lsp.server",
    });
  }),
);

it.effect(
  "rejects a custom command with a blank executable",
  Effect.fn(function* () {
    const result = yield* Effect.result(
      resolveMarimoLspServer({
        server: "custom",
        path: ["   ", "--stdio"],
      }),
    );

    assert(Result.isFailure(result));
    expect(result.failure).toMatchObject({
      _tag: "InvalidMarimoLspConfiguration",
      setting: "marimo.lsp.path",
    });
  }),
);
