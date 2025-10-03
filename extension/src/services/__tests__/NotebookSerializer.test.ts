import { describe, expect, it } from "vitest";
import packageJson from "../../../package.json";
import { NOTEBOOK_TYPE } from "../../constants.ts";

describe("NotebookSerializer", () => {
  it("NOTEBOOK_TYPE matches package.json notebook type", () => {
    const notebookConfig = packageJson.contributes.notebooks.find(
      (nb) => nb.type === NOTEBOOK_TYPE,
    );
    expect(notebookConfig).toBeDefined();
    expect(notebookConfig?.type).toBe(NOTEBOOK_TYPE);
  });
});
