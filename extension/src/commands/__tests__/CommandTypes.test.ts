import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type * as vscode from "vscode";

import { defineCommand } from "../../commands.ts";
import { VsCode } from "../../platform/VsCode.ts";
import { Invocation } from "../Invocation.ts";
import { MarimoCommands } from "../MarimoCommands.ts";

const typecheckedUsage = (cell: vscode.NotebookCell) =>
  Effect.gen(function* () {
    const code = yield* VsCode;

    code.commands.bind(MarimoCommands.runStale, "Run stale cells", cell);
    code.commands.bind(
      MarimoCommands.updateCellMetadata,
      "Update metadata",
      cell,
      "sql.output",
    );

    // runStale cannot be bound to a session item.
    code.commands.bind(MarimoCommands.runStale, "Run stale cells", {
      // @ts-expect-error incompatible invocation argument
      notebookUri: "file:///notebook.py",
    });

    // @ts-expect-error metadata bindings require the binding ID after the cell
    code.commands.bind(
      MarimoCommands.updateCellMetadata,
      "Update metadata",
      cell,
    );

    // runStale handlers receive a normalized notebook target.
    defineCommand(
      // @ts-expect-error incompatible handler argument
      MarimoCommands.runStale,
      (_cell: vscode.NotebookCell) => Effect.void,
    );

    // Joined adapters must normalize to one exact handler tuple.
    Invocation.join(
      Invocation.NotebookToolbar.notebook,
      // @ts-expect-error incompatible normalized target
      Invocation.NotebookCellTitle.notebookCell,
    );
  });

it("keeps registration and bindings statically compatible", () => {
  expect(typecheckedUsage).toBeDefined();
});
