import * as Vitest from "@effect/vitest";
import { Effect } from "effect";

import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { commandId } from "../../commands.ts";
import enableCell from "../../commands/enableCell.ts";
import runStale from "../../commands/runStale.ts";
import * as TestCellStatusBarProvider from "./TestCellStatusBarProvider.ts";

const it = EffectTest.make(TestCellStatusBarProvider.layer);

const contains = (
  items: ReadonlyArray<{ readonly text: string }>,
  text: string,
) => items.some((item) => item.text.includes(text));

Vitest.describe("CellStatusBarProvider", () => {
  it.effect(
    "registers staleness, name, and disabled providers",
    Effect.fn(function* () {
      const statusBar = yield* TestCellStatusBarProvider.Service;
      Vitest.expect(yield* statusBar.providerCount).toBe(3);
    }),
  );

  it.effect(
    "does not show staleness before a cell has executed",
    Effect.fn(function* () {
      const statusBar = yield* TestCellStatusBarProvider.Service;
      const cell = TestCellStatusBarProvider.makeCell({
        marimo: { name: "test_cell" },
        marimoRuntime: { stableId: "cell-1" },
      });

      Vitest.expect(contains(yield* statusBar.items(cell), "Stale")).toBe(
        false,
      );
    }),
  );

  it.effect(
    "does not show staleness after execution",
    Effect.fn(function* () {
      const statusBar = yield* TestCellStatusBarProvider.Service;
      const cell = TestCellStatusBarProvider.makeCell({
        marimo: { name: "test_cell" },
        marimoRuntime: { stableId: "cell-1" },
      });

      yield* statusBar.markExecuted(cell);

      Vitest.expect(contains(yield* statusBar.items(cell), "Stale")).toBe(
        false,
      );
    }),
  );

  it.effect(
    "shows staleness after invalidation",
    Effect.fn(function* () {
      const statusBar = yield* TestCellStatusBarProvider.Service;
      const cell = TestCellStatusBarProvider.makeCell({
        marimo: { name: "test_cell" },
        marimoRuntime: { stableId: "cell-1" },
      });
      yield* statusBar.markStale(cell);

      const stale = (yield* statusBar.items(cell)).find((item) =>
        item.text.includes("Stale"),
      );

      Vitest.expect(stale?.text).toContain("Stale");
      Vitest.expect(stale?.tooltip).toContain("edited but not re-executed");
      Vitest.expect(stale?.command).toEqual({
        command: commandId(runStale.command),
        title: "Run stale cells",
        arguments: [cell],
      });
    }),
  );

  it.effect(
    "does not show the default cell name",
    Effect.fn(function* () {
      const statusBar = yield* TestCellStatusBarProvider.Service;
      const cell = TestCellStatusBarProvider.makeCell({
        marimo: { name: "_" },
      });

      Vitest.expect(yield* statusBar.items(cell)).toEqual([]);
    }),
  );

  it.effect(
    "shows a custom cell name",
    Effect.fn(function* () {
      const statusBar = yield* TestCellStatusBarProvider.Service;
      const cell = TestCellStatusBarProvider.makeCell({
        marimo: { name: "my_custom_cell" },
      });

      const item = (yield* statusBar.items(cell)).find((item) =>
        item.text.includes("my_custom_cell"),
      );
      Vitest.expect(item?.text).toContain("my_custom_cell");
      Vitest.expect(item?.tooltip).toContain("Cell name: my_custom_cell");
    }),
  );

  it.effect(
    "shows the setup cell with a gear icon",
    Effect.fn(function* () {
      const statusBar = yield* TestCellStatusBarProvider.Service;
      const cell = TestCellStatusBarProvider.makeCell({
        marimo: { name: "setup" },
      });

      const item = (yield* statusBar.items(cell)).find((item) =>
        item.text.includes("setup"),
      );
      Vitest.expect(item?.text).toContain("$(gear)");
      Vitest.expect(item?.tooltip).toContain("Setup cell");
    }),
  );

  it.effect(
    "shows no items for a cell without metadata",
    Effect.fn(function* () {
      const statusBar = yield* TestCellStatusBarProvider.Service;
      const cell = TestCellStatusBarProvider.makeCell();

      Vitest.expect(yield* statusBar.items(cell)).toEqual([]);
    }),
  );

  it.effect(
    "shows staleness and name simultaneously",
    Effect.fn(function* () {
      const statusBar = yield* TestCellStatusBarProvider.Service;
      const cell = TestCellStatusBarProvider.makeCell({
        marimo: { name: "my_cell" },
        marimoRuntime: { stableId: "cell-2" },
      });
      yield* statusBar.markStale(cell);

      const items = yield* statusBar.items(cell);
      Vitest.expect(contains(items, "Stale")).toBe(true);
      Vitest.expect(contains(items, "my_cell")).toBe(true);
    }),
  );

  it.effect(
    "shows an enable action only for disabled cells",
    Effect.fn(function* () {
      const statusBar = yield* TestCellStatusBarProvider.Service;
      const enabled = TestCellStatusBarProvider.makeCell({
        marimo: { options: { disabled: false } },
        marimoRuntime: { stableId: "enabled" },
      });
      const disabled = TestCellStatusBarProvider.makeCell({
        marimo: { options: { disabled: true } },
        marimoRuntime: { stableId: "disabled" },
      });

      const enabledItems = yield* statusBar.items(enabled);
      Vitest.expect(
        enabledItems.some(
          (item) =>
            typeof item.command !== "string" &&
            item.command?.command === commandId(enableCell.command),
        ),
      ).toBe(false);

      const item = (yield* statusBar.items(disabled)).find(
        (item) =>
          typeof item.command !== "string" &&
          item.command?.command === commandId(enableCell.command),
      );
      Vitest.expect(item?.text).toBe("$(circle-slash) Disabled");
      Vitest.expect(item?.tooltip).toBe("Cell is disabled; click to enable");
      Vitest.expect(item?.command).toEqual({
        command: commandId(enableCell.command),
        title: "Enable cell",
        arguments: [disabled],
      });
    }),
  );
});
