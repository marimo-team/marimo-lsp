import { describe, expect, it } from "@effect/vitest";
import { Effect, Either } from "effect";

import { commandId, decodeCommandArguments } from "../../commands.ts";
import { GeneratedMarimoCommands } from "../MarimoCommands.gen.ts";
import { MarimoCommands } from "../MarimoCommands.ts";

describe("MarimoCommands", () => {
  it("covers every generated command exactly once", () => {
    expect(Object.keys(MarimoCommands).toSorted()).toEqual(
      Object.keys(GeneratedMarimoCommands).toSorted(),
    );
    expect(Object.values(MarimoCommands).map(commandId).toSorted()).toEqual(
      Object.values(GeneratedMarimoCommands).map(commandId).toSorted(),
    );
  });

  it.effect("rejects arguments for a no-argument command", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        decodeCommandArguments(MarimoCommands.restartKernel, ["unexpected"]),
      );
      expect(Either.isLeft(result)).toBe(true);
    }),
  );

  it.effect("accepts an empty argument list for a no-argument command", () =>
    Effect.gen(function* () {
      const args = yield* decodeCommandArguments(
        MarimoCommands.restartKernel,
        [],
      );
      expect(args).toEqual([]);
    }),
  );

  it.effect("decodes the first external argument for open-as-notebook", () =>
    Effect.gen(function* () {
      const args = yield* decodeCommandArguments(
        MarimoCommands.openAsMarimoNotebook,
        ["file:///notebook.py", { external: "context" }],
      );
      expect(args).toEqual(["file:///notebook.py"]);
    }),
  );
});
