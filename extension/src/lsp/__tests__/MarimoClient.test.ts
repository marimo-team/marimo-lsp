import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Ref, Stream } from "effect";

import { notebookId } from "../../lib/__tests__/branded.ts";
import type { MarimoApiCall, MarimoOperation } from "../../types.ts";
import {
  findMarimoLspExecutable,
  makeMarimoCommands,
  makeMarimoOperationStream,
} from "../MarimoClient.ts";

const notebook = notebookId("notebook-a");

it.scoped(
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
      operations: () => Stream.empty,
    });

    yield* marimo.executeCells({
      notebookUri: notebook,
      executable: "/python",
      inner: { cellIds: [], codes: [] },
    });
    yield* marimo.setDisplayTheme({ theme: "dark" });

    assert.deepStrictEqual(yield* Ref.get(calls), [
      {
        method: "execute-cells",
        params: {
          notebookUri: notebook,
          executable: "/python",
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
  it.scoped(
    "parses responses against the method's success schema",
    Effect.fn(function* () {
      const marimo = makeMarimoCommands({
        execute: () =>
          Effect.succeed({
            tree: { name: "root", version: null, tags: [], dependencies: [] },
          }),
        operations: () => Stream.empty,
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

  it.scoped(
    "fails with ParseError when the server response violates the contract",
    Effect.fn(function* () {
      const marimo = makeMarimoCommands({
        execute: () => Effect.succeed({ tree: "not-a-tree" }),
        operations: () => Stream.empty,
      });

      const exit = yield* marimo
        .getDependencyTree({
          notebookUri: notebook,
          source: { kind: "script" },
          inner: {},
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "DependencyTreeResponse");
    }),
  );

  it.scoped(
    "rejects params the server would reject, before hitting the wire",
    Effect.fn(function* () {
      const marimo = makeMarimoCommands({
        execute: () => Effect.die("should not reach the transport"),
        operations: () => Stream.empty,
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

  it.scoped(
    "requires tagged-union discriminators before hitting the wire",
    Effect.fn(function* () {
      const marimo = makeMarimoCommands({
        execute: () => Effect.die("should not reach the transport"),
        operations: () => Stream.empty,
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
  it.scoped("uses a compatible Python range for the bundled LSP", () =>
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

it.scoped(
  "subscribes to marimo operations",
  Effect.fn(function* () {
    let requestedNotification: string | undefined;
    const marimo = makeMarimoCommands({
      execute: () => Effect.void,
      operations: () => {
        requestedNotification = "marimo/operation";
        return Stream.empty;
      },
    });

    yield* marimo.operations().pipe(Stream.runDrain);

    assert.strictEqual(requestedNotification, "marimo/operation");
  }),
);

it.scoped(
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
        operations().pipe(Stream.take(1), Stream.runHead),
        operations().pipe(Stream.take(1), Stream.runHead),
        Effect.gen(function* () {
          yield* Effect.yieldNow();
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
