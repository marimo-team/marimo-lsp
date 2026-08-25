import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import { createTestNotebookDocument, Uri } from "../../__mocks__/TestVsCode.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import { conventionalSessionCachePath } from "../readNotebookOutputs.ts";

describe("conventionalSessionCachePath", () => {
  it("resolves a sidecar in a remote extension host", () => {
    const document = createTestNotebookDocument(
      Uri.from({
        scheme: "vscode-remote",
        authority: "ssh-remote+host",
        path: "/workspace/notebook.py",
      }),
    );

    expect(
      conventionalSessionCachePath(MarimoNotebookDocument.from(document)),
    ).toBe(
      NodePath.join(
        NodePath.dirname(document.uri.fsPath),
        "__marimo__",
        "session",
        "notebook.py.json",
      ),
    );
  });
});
