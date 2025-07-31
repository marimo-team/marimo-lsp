import * as React from "react";
import type {
  OutputItem,
  OutputItem as OutputItemData,
} from "vscode-notebook-renderer";

export function OutputItem({ data }: { data: OutputItemData }) {
  return <pre>{data.text()}</pre>;
}
