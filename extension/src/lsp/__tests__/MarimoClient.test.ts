import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Ref, Stream } from "effect";
import { vi } from "vite-plus/test";

import { MarimoLspServer } from "../../config/Config.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import type { MarimoApiCall, MarimoOperation } from "../../types.ts";
import {
  disposeLanguageClient,
  findMarimoLspExecutable,
  findWasmMarimoLspExecutable,
  makeMarimoCommands,
  makeMarimoOperationStream,
  selectMarimoLspExecutable,
} from "../MarimoClient.ts";

const notebook = notebookId("notebook-a");

it.effect(
  "does not fail scope cleanup when language-client disposal rejects",
  Effect.fn(function* () {
    const dispose = vi.fn(() =>
      Promise.reject(new Error("client is startFailed")),
    );

    yield* disposeLanguageClient({ dispose });

    expect(dispose).toHaveBeenCalledOnce();
  }),
);

it.effect(
  "constructs marimo.api commands through named methods",
  Effect.fn(function* () {
    const calls = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
    const responses: Record<string, unknown> = {
      "execute-cells": null,
      "set-display-theme": { success: true },
    };
    const marimo = makeMarimoCommands({
      execute: (request) =>
        Ref.update(calls, (current) => [...current, request]).pipe(
          Effect.as(responses[request.method]),
        ),
      operations: Stream.empty,
    });

    yield* marimo.executeCells({
      notebookUri: notebook,
      executable: "/python",
      workingDirectory: "/workspace",
      inner: { cellIds: [], codes: [] },
    });
    yield* marimo.setDisplayTheme({ theme: "dark" });

    assert.deepStrictEqual(yield* Ref.get(calls), [
      {
        method: "execute-cells",
        params: {
          notebookUri: notebook,
          executable: "/python",
          workingDirectory: "/workspace",
          inner: { cellIds: [], codes: [] },
        },
      },
      {
        method: "set-display-theme",
        params: { theme: "dark" },
      },
    ]);
  }),
);

describe("generated api client", () => {
  it.effect(
    "parses responses against the method's success schema",
    Effect.fn(function* () {
      const marimo = makeMarimoCommands({
        execute: () =>
          Effect.succeed({
            tree: { name: "root", version: null, tags: [], dependencies: [] },
          }),
        operations: Stream.empty,
      });

      const response = yield* marimo.getDependencyTree({
        notebookUri: notebook,
        source: { kind: "script" },
        inner: {},
      });

      // Response is parsed, not asserted: `tree` is a typed DependencyTreeNode.
      assert.strictEqual(response.tree?.name, "root");
    }),
  );

  it.effect(
    "fails with ParseError when the server response violates the contract",
    Effect.fn(function* () {
      const marimo = makeMarimoCommands({
        execute: () => Effect.succeed({ tree: "not-a-tree" }),
        operations: Stream.empty,
      });

      const exit = yield* marimo
        .getDependencyTree({
          notebookUri: notebook,
          source: { kind: "script" },
          inner: {},
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      // The formatter names the schema and the path of the field that
      // failed. It does not name the response type that contains it.
      assert.include(String(exit), "SchemaError");
      assert.include(String(exit), "DependencyTreeNode");
      assert.include(String(exit), '["tree"]');
    }),
  );

  it.effect(
    "rejects params the server would reject, before hitting the wire",
    Effect.fn(function* () {
      const marimo = makeMarimoCommands({
        execute: () => Effect.die("should not reach the transport"),
        operations: Stream.empty,
      });

      const exit = yield* marimo
        .getDependencyTree({
          notebookUri: notebook,
          // @ts-expect-error -- deliberately malformed source
          source: { kind: "conda" },
          inner: {},
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "PackageSource");
    }),
  );

  it.effect(
    "requires tagged-union discriminators before hitting the wire",
    Effect.fn(function* () {
      const marimo = makeMarimoCommands({
        execute: () => Effect.die("should not reach the transport"),
        operations: Stream.empty,
      });

      const exit = yield* marimo
        .getDependencyTree({
          notebookUri: notebook,
          // @ts-expect-error -- msgspec requires `kind` for union decoding
          source: { executable: "/usr/bin/python3" },
          inner: {},
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "PackageSource");
    }),
  );
});

describe("findMarimoLspExecutable", () => {
  it.effect("uses a compatible Python range for the bundled LSP", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        NodeFs.mkdtempDisposableSync(
          NodePath.join(NodeOs.tmpdir(), "marimo-lsp-client-"),
        ),
      ),
      (directory) =>
        Effect.gen(function* () {
          const sdist = NodePath.join(directory.path, "marimo_lsp-0.1.0");
          NodeFs.mkdirSync(sdist);

          const executable = yield* findMarimoLspExecutable(
            "bundled-uv",
            directory.path,
          );

          expect(executable).toEqual({
            command: "bundled-uv",
            args: [
              "tool",
              "run",
              "--python",
              ">=3.13,<3.15",
              "--from",
              sdist,
              "marimo-lsp",
            ],
          });
        }),
      (directory) => Effect.sync(() => directory.remove()),
    ),
  );
});

describe("findWasmMarimoLspExecutable", () => {
  it("launches the bundled server with VS Code's Node runtime", () => {
    const executable = findWasmMarimoLspExecutable("/extension/dist");

    expect(executable.command).toBe(process.execPath);
    expect(executable.args).toEqual([
      NodePath.join("/extension/dist", "wasmServer.js"),
    ]);
    expect(executable.options?.env?.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});

describe("selectMarimoLspExecutable", () => {
  it.effect(
    "uses the command carried by the custom server variant",
    Effect.fn(function* () {
      const selection = yield* selectMarimoLspExecutable({
        server: MarimoLspServer.Custom({
          command: ["/custom/marimo-lsp", "--stdio"],
        }),
        resolveUvBinary: Effect.die("custom mode must not resolve uv"),
        searchDirectory: "/does/not/exist",
      });

      expect(selection).toEqual({
        _tag: "Configured",
        exec: { command: "/custom/marimo-lsp", args: ["--stdio"] },
      });
    }),
  );

  it.effect(
    "uses WASM without resolving uv",
    Effect.fn(function* () {
      const selection = yield* selectMarimoLspExecutable({
        server: MarimoLspServer.Wasm(),
        resolveUvBinary: Effect.die("WASM mode must not resolve uv"),
        searchDirectory: "/extension/dist",
      });

      expect(selection._tag).toBe("Wasm");
      expect(selection.exec.args).toEqual([
        NodePath.join("/extension/dist", "wasmServer.js"),
      ]);
    }),
  );

  it.effect("resolves uv only for the Python server variant", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        NodeFs.mkdtempDisposableSync(
          NodePath.join(NodeOs.tmpdir(), "marimo-lsp-selection-"),
        ),
      ),
      (directory) =>
        Effect.gen(function* () {
          const selection = yield* selectMarimoLspExecutable({
            server: MarimoLspServer.Python(),
            resolveUvBinary: Effect.succeed("bundled-uv"),
            searchDirectory: directory.path,
          });

          expect(selection).toEqual({
            _tag: "Uv",
            exec: {
              command: "bundled-uv",
              args: ["run", "--directory", directory.path, "marimo-lsp"],
            },
          });
        }),
      (directory) => Effect.sync(() => directory.remove()),
    ),
  );
});

it.effect(
  "subscribes to marimo operations",
  Effect.fn(function* () {
    let requestedNotification: string | undefined;
    const marimo = makeMarimoCommands({
      execute: () => Effect.void,
      // Stream.suspend defers to subscription time, so the assertion below
      // still observes that draining `operations` evaluated the transport.
      operations: Stream.suspend(() => {
        requestedNotification = "marimo/operation";
        return Stream.empty;
      }),
    });

    yield* marimo.operations.pipe(Stream.runDrain);

    assert.strictEqual(requestedNotification, "marimo/operation");
  }),
);

it.effect(
  "broadcasts marimo operations without replacing the transport handler",
  Effect.fn(function* () {
    let registrations = 0;
    let notify: ((message: MarimoOperation) => void) | undefined;
    const operations = yield* makeMarimoOperationStream((handler) => {
      registrations += 1;
      notify = handler;
      return { dispose() {} };
    });

    const message = {
      notebookUri: notebook,
      operation: { op: "completed-run", run_id: null },
    } as const;
    const [first, second] = yield* Effect.all(
      [
        operations.pipe(Stream.take(1), Stream.runHead),
        operations.pipe(Stream.take(1), Stream.runHead),
        Effect.gen(function* () {
          yield* Effect.yieldNow;
          assert.ok(notify);
          notify(message);
        }),
      ],
      { concurrency: "unbounded" },
    );

    assert.strictEqual(registrations, 1);
    assert.deepStrictEqual(first, Option.some(message));
    assert.deepStrictEqual(second, Option.some(message));
  }),
);
