import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

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

  it.effect("ignores VS Code context for a context-free command", () =>
    Effect.gen(function* () {
      const args = yield* decodeCommandArguments(MarimoCommands.restartLsp, [
        {
          ui: true,
          notebookEditor: { notebookUri: "file:///notebook.py" },
          source: "notebookToolbar",
        },
      ]);
      expect(args).toEqual([]);
    }),
  );

  it.effect("accepts an empty argument list for a no-argument command", () =>
    Effect.gen(function* () {
      const args = yield* decodeCommandArguments(MarimoCommands.restartLsp, []);
      expect(args).toEqual([]);
    }),
  );

  it.effect("decodes optional notebook toolbar context", () =>
    Effect.gen(function* () {
      const notebookUri = {
        scheme: "file",
        path: "/notebook.py",
        with() {
          return this;
        },
        toString() {
          return "file:///notebook.py";
        },
      };
      const args = yield* decodeCommandArguments(MarimoCommands.restartKernel, [
        {
          ui: true,
          notebookEditor: { notebookUri },
          source: "notebookToolbar",
        },
      ]);
      expect(args).toEqual([{ notebookEditor: { notebookUri } }]);
    }),
  );

  it.effect("accepts no context for a notebook command", () =>
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
