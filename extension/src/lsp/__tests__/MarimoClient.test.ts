import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Stream } from "effect";

import { notebookId } from "../../lib/__tests__/branded.ts";
import type { MarimoCommand } from "../../types.ts";
import {
  findMarimoLspExecutable,
  makeMarimoCommands,
} from "../MarimoClient.ts";

const notebook = notebookId("notebook-a");

it.scoped(
  "constructs marimo.api commands through named methods",
  Effect.fn(function* () {
    const commands = yield* Ref.make<ReadonlyArray<MarimoCommand>>([]);
    const marimo = makeMarimoCommands({
      execute: (request) => {
        const command: MarimoCommand = {
          command: "marimo.api",
          params: request,
        };
        return Ref.update(commands, (current) => [...current, command]);
      },
      operations: () => Stream.empty,
    });

    yield* marimo.executeCells({
      notebookUri: notebook,
      executable: "/python",
      inner: { cellIds: [], codes: [] },
    });
    yield* marimo.setDisplayTheme({ theme: "dark" });

    assert.deepStrictEqual(yield* Ref.get(commands), [
      {
        command: "marimo.api",
        params: {
          method: "execute-cells",
          params: {
            notebookUri: notebook,
            executable: "/python",
            inner: { cellIds: [], codes: [] },
          },
        },
      },
      {
        command: "marimo.api",
        params: {
          method: "set-display-theme",
          params: { theme: "dark" },
        },
      },
    ]);
  }),
);

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
