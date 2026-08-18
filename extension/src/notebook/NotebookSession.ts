import { Context } from "effect";

import type { NotebookDocumentSession } from "./NotebookDocumentSessions.ts";

/** The document session captured by a notebook-local layer. */
export class NotebookSession extends Context.Service<
  NotebookSession,
  NotebookDocumentSession
>()("NotebookSession") {}
