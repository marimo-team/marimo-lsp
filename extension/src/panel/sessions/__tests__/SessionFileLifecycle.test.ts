import { describe, expect, it } from "vitest";

import { Uri } from "../../../__mocks__/TestVsCode.ts";
import {
  containsNotebookUri,
  rebaseNotebookUri,
} from "../SessionFileLifecycle.ts";

describe("session file lifecycle URI reconciliation", () => {
  it("rebases a session when an ancestor directory is renamed", () => {
    expect(
      rebaseNotebookUri(
        Uri.parse("file:///workspace/old/nested/notebook.py"),
        Uri.parse("file:///workspace/old"),
        Uri.parse("file:///workspace/new"),
      ),
    ).toBe("file:///workspace/new/nested/notebook.py");
  });

  it("does not match sibling paths with the same prefix", () => {
    const parent = Uri.parse("file:///workspace/demo");
    const sibling = Uri.parse("file:///workspace/demo-copy/notebook.py");

    expect(containsNotebookUri(parent, sibling)).toBe(false);
    expect(
      rebaseNotebookUri(
        sibling,
        parent,
        Uri.parse("file:///workspace/renamed"),
      ),
    ).toBeUndefined();
  });

  it("recognizes notebooks below a deleted directory", () => {
    expect(
      containsNotebookUri(
        Uri.parse("file:///workspace/deleted"),
        Uri.parse("file:///workspace/deleted/nested/notebook.py"),
      ),
    ).toBe(true);
  });
});
