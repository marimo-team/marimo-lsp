import { Schema } from "effect";

import { NotebookIdFromString } from "../../schemas/MarimoNotebookDocument.ts";

export const SessionInfo = Schema.Struct({
  sessionId: Schema.String,
  notebookUri: NotebookIdFromString,
  filename: Schema.NullOr(Schema.String),
  executable: Schema.String,
  startedAt: Schema.Number,
  status: Schema.Literal("idle", "running"),
  attached: Schema.Boolean,
});

export type SessionInfo = typeof SessionInfo.Type;

export const SessionsSnapshot = Schema.Struct({
  sessions: Schema.Array(SessionInfo),
});

export type SessionsSnapshot = typeof SessionsSnapshot.Type;
