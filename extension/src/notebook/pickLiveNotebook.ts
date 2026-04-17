import { Effect, Option } from "effect";
import type * as vscode from "vscode";

import { NOTEBOOK_TYPE } from "../constants.ts";
import type { VsCode } from "../platform/VsCode.ts";

/**
 * Find the live `NotebookDocument` that `bytes` was deserialized from by
 * comparing `bytes` against each open marimo notebook's current on-disk
 * content. If a URI's file bytes equal `bytes`, that document is the one
 * VS Code is reloading — a much stronger identity signal than structural
 * matching because the OS just wrote those bytes and we're reading the
 * same file back within milliseconds.
 *
 * Checks the active notebook editor first (most common case: the user is
 * looking at the notebook that was edited externally), then falls through
 * to the remaining marimo notebooks in `workspace.notebookDocuments`.
 *
 * Returns `None` when no candidate matches. Callers treat that as "fresh
 * deserialize with no outputs to preserve" — which is correct on cold opens
 * (no doc is open yet) and racy double-writes (disk has already advanced
 * past the bytes we were given).
 */
export const pickLiveNotebook = Effect.fn("pickLiveNotebook")(function* (
  bytes: Uint8Array,
  code: VsCode,
) {
  const active = yield* code.window.getActiveNotebookEditor();
  const activeDoc = Option.map(active, (editor) => editor.notebook);

  if (Option.isSome(activeDoc) && isMarimoNotebook(activeDoc.value)) {
    const matched = yield* matchesOnDisk(bytes, activeDoc.value, code);
    if (matched) {
      return Option.some(activeDoc.value);
    }
  }

  const all = yield* code.workspace.getNotebookDocuments();
  for (const doc of all) {
    if (!isMarimoNotebook(doc)) continue;
    if (Option.isSome(activeDoc) && doc === activeDoc.value) continue;
    const matched = yield* matchesOnDisk(bytes, doc, code);
    if (matched) {
      return Option.some(doc);
    }
  }

  yield* Effect.logTrace(
    "pickLiveNotebook: no open marimo notebook matches incoming bytes",
  );
  return Option.none<vscode.NotebookDocument>();
});

const isMarimoNotebook = (doc: vscode.NotebookDocument): boolean =>
  doc.notebookType === NOTEBOOK_TYPE;

const matchesOnDisk = Effect.fn(function* (
  bytes: Uint8Array,
  doc: vscode.NotebookDocument,
  code: VsCode,
) {
  const disk = yield* code.workspace.fs.readFile(doc.uri).pipe(Effect.option);
  if (Option.isNone(disk)) return false;
  return bytesEqual(disk.value, bytes);
});

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};
