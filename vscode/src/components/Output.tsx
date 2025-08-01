import * as React from "react";
import type * as vscode from "vscode-notebook-renderer";
import { useRendererContext } from "../hooks/useRendererContext.ts";

export function OutputItem({ data }: { data: vscode.OutputItem }) {
  const context = useRendererContext();
  return <div dangerouslySetInnerHTML={{ __html: data.text() }}></div>;
}
