import { assert, it } from "@effect/vitest";
import { Effect, Layer, Ref, Stream } from "effect";

import { notebookId } from "../../lib/__tests__/branded.ts";
import type { MarimoCommand } from "../../types.ts";
import { LanguageClient } from "../LanguageClient.ts";
import { MarimoApiClient } from "../MarimoApiClient.ts";

it.scoped(
  "MarimoApiClient constructs typed marimo.api commands",
  Effect.fn(function* () {
    const notebook = notebookId("notebook-a");
    const commands = yield* Ref.make<ReadonlyArray<MarimoCommand>>([]);
    const client = Layer.succeed(
      LanguageClient,
      LanguageClient.make({
        channel: { name: "marimo-lsp", show() {} },
        restart: () => Effect.void,
        executeCommand: (command) =>
          Ref.update(commands, (current) => [...current, command]),
        streamOf() {
          // SAFETY: this client is only used to test command execution.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          return Stream.empty as never;
        },
      }),
    );

    yield* Effect.gen(function* () {
      const api = yield* MarimoApiClient;
      yield* api.setDisplayTheme({ theme: "dark" });
      yield* api.getConfiguration({
        notebookUri: notebook,
        inner: {},
      });

      assert.deepStrictEqual(yield* Ref.get(commands), [
        {
          command: "marimo.api",
          params: {
            method: "set-display-theme",
            params: { theme: "dark" },
          },
        },
        {
          command: "marimo.api",
          params: {
            method: "get-configuration",
            params: {
              notebookUri: notebook,
              inner: {},
            },
          },
        },
      ]);
    }).pipe(Effect.provide(MarimoApiClient.Default), Effect.provide(client));
  }),
);
