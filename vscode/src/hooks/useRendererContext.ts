import * as React from "react";
import type * as vscode from "vscode-notebook-renderer";

import { assert } from "../assert.ts";

export const RendererContext = React.createContext<
  Required<vscode.RendererContext<unknown>> | null
>(null);

export function useRendererContext() {
  const context = React.useContext(RendererContext);
  assert(context, "Must be called within RendererContext.Provider");
  return context;
}
