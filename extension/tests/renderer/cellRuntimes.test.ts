import { CellId } from "@marimo-team/frontend/unstable_internal/core/cells/ids.ts";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { describe, expect, it } from "vite-plus/test";

import { CellRuntimes } from "../../src/renderer/cellRuntimes.ts";

describe("CellRuntimes", () => {
  it("restores a sibling snapshot when the newest output is disposed", () => {
    const runtimes = new CellRuntimes();
    const cellId = CellId.create();
    const consoleState = createCellRuntimeState({ output: null });
    const mainState = createCellRuntimeState({ consoleOutputs: [] });
    const releaseConsole = runtimes.register(cellId, consoleState);
    const releaseMain = runtimes.register(cellId, mainState);

    expect(releaseMain()).toBe(consoleState);
    expect(releaseConsole()).toBeUndefined();
  });

  it("keeps the newest snapshot when an older output is disposed", () => {
    const runtimes = new CellRuntimes();
    const cellId = CellId.create();
    const older = createCellRuntimeState();
    const newer = createCellRuntimeState();
    const releaseOlder = runtimes.register(cellId, older);
    const releaseNewer = runtimes.register(cellId, newer);

    expect(releaseOlder()).toBe(newer);
    expect(releaseNewer()).toBeUndefined();
  });

  it("counts separate registrations of the same snapshot", () => {
    const runtimes = new CellRuntimes();
    const cellId = CellId.create();
    const state = createCellRuntimeState();
    const releaseFirst = runtimes.register(cellId, state);
    const releaseSecond = runtimes.register(cellId, state);

    expect(releaseSecond()).toBe(state);
    expect(releaseSecond()).toBe(state);
    expect(releaseFirst()).toBeUndefined();
  });

  it("does not release a new registration when an old cleanup is repeated", () => {
    const runtimes = new CellRuntimes();
    const cellId = CellId.create();
    const releaseOld = runtimes.register(cellId, createCellRuntimeState());
    expect(releaseOld()).toBeUndefined();

    const replacement = createCellRuntimeState();
    const releaseReplacement = runtimes.register(cellId, replacement);
    expect(releaseOld()).toBe(replacement);
    expect(releaseReplacement()).toBeUndefined();
  });

  it("tracks different cells independently", () => {
    const runtimes = new CellRuntimes();
    const first = CellId.create();
    const second = CellId.create();
    const firstState = createCellRuntimeState();
    const releaseFirst = runtimes.register(first, firstState);
    const releaseSecond = runtimes.register(second, createCellRuntimeState());
    const releaseSibling = runtimes.register(first, createCellRuntimeState());

    expect(releaseSecond()).toBeUndefined();
    expect(releaseSibling()).toBe(firstState);
    expect(releaseFirst()).toBeUndefined();
  });
});
