import { Schema } from "effect";

import { NotebookIdFromString } from "../../schemas/MarimoNotebookDocument.ts";
import {
  ListSessionsResponse as GeneratedSessionsSnapshot,
  SessionInfo as GeneratedSessionInfo,
} from "../../schemas/Models.gen.ts";

export const SessionInfo = Schema.Struct({
  ...GeneratedSessionInfo.fields,
  notebookUri: NotebookIdFromString,
});

export type SessionInfo = typeof SessionInfo.Type;

export const SessionsSnapshot = Schema.Struct({
  ...GeneratedSessionsSnapshot.fields,
  sessions: Schema.Array(SessionInfo),
});

export type SessionsSnapshot = typeof SessionsSnapshot.Type;
