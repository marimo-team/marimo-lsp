import { Context } from "effect";

import * as NotebookDocumentSessions from "./NotebookDocumentSessions.ts";

/** The document session captured by a notebook-local layer. */
export type Interface = NotebookDocumentSessions.Session;

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/NotebookSession",
) {}
