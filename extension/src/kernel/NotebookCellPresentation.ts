import type { Effect } from "effect";

import type { CellOperationNotification } from "../types.ts";
import type { Drive } from "./DocumentExecutionSession.ts";

/** Presentation operations bound to one exact notebook and controller. */
export interface NotebookCellPresentation {
  readonly present: Drive;
  readonly presentSavedOutputs: (
    notifications: ReadonlyArray<CellOperationNotification>,
    notebookVersion: number,
    onPresented: (
      notification: CellOperationNotification,
    ) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
}
