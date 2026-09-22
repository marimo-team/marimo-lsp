import { Context } from "effect";

import * as NotebookDocumentSessions from "./NotebookDocumentSessions.ts";

/** The document session captured by a notebook-local layer. */
export class NotebookSession extends Context.Service<
  NotebookSession,
  NotebookDocumentSessions.Session
>()("NotebookSession") {}
