import type { Effect } from "effect";

import type { NotebookCellId } from "../schemas/MarimoNotebookDocument.ts";
import type { SavedCellOutput } from "../schemas/Models.gen.ts";
import type { Drive } from "./DocumentExecutionSession.ts";

/** Presentation operations bound to one exact notebook and controller. */
export interface NotebookCellPresentation {
  readonly present: Drive;
  readonly presentSavedOutputs: (
    outputs: ReadonlyArray<SavedCellOutput>,
    notebookVersion: number,
    onPresented: (cellId: NotebookCellId) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
}
