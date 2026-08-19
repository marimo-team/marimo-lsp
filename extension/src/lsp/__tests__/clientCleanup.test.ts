import { expect, it } from "@effect/vitest";
import { Effect, Logger } from "effect";

import { runLspCleanup } from "../client.ts";

it.effect(
  "suppresses canceled LSP cleanup",
  Effect.fn(function* () {
    const logs: Array<{ level: string; message: unknown }> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      logs.push({ level: logLevel, message });
    });
    const canceled = new Error("Canceled");
    canceled.name = "Canceled";

    yield* runLspCleanup("connection.dispose", () => {
      throw canceled;
    }).pipe(Effect.provide(Logger.layer([logger])));

    expect(logs).toEqual([]);
  }),
);

it.effect(
  "downgrades other LSP cleanup failures to warnings",
  Effect.fn(function* () {
    const logs: Array<{ level: string; message: unknown }> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      logs.push({ level: logLevel, message });
    });

    yield* runLspCleanup("connection.dispose", () => {
      throw new Error("boom");
    }).pipe(Effect.provide(Logger.layer([logger])));

    expect(logs).toEqual([
      {
        level: "Warn",
        message: ["LSP cleanup failed during connection.dispose"],
      },
    ]);
  }),
);
