import { describe, expect, it } from "@effect/vitest";

import { NOTEBOOK_MENU_ITEMS } from "../showNotebookMenu.ts";

describe("showNotebookMenu", () => {
  it("offers a focused four-item notebook menu", () => {
    expect(NOTEBOOK_MENU_ITEMS.map((item) => item.label)).toEqual([
      "$(zap) Reactivity",
      "$(save-all) Automatic exports",
      "$(gear) Create setup cell",
      "$(cloud-upload) Publish notebook",
    ]);
  });
});
