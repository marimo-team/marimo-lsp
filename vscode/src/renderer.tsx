/// <reference lib="dom" />
/// <reference types="vscode-notebook-renderer" />

import * as React from "react";
import * as ReactDOM from "react-dom/client";
import type { ActivationFunction } from "vscode-notebook-renderer";

import { OutputItem } from "./components/Output.tsx";
import { assert } from "./assert.ts";

export const activate: ActivationFunction<unknown> = async (context) => {
  assert(
    context.postMessage && context.onDidReceiveMessage,
    "Messaging is required.",
  );
  const registry = new Map<string, ReactDOM.Root>();
  context.onDidReceiveMessage((e) => {
    console.log(e);
  });
  return {
    renderOutputItem(data, element, signal) {
      let root = ReactDOM.createRoot(element);
      root.render(<OutputItem data={data} />);
      registry.set(data.id, root);
      signal.addEventListener("abort", () => {
        root.unmount();
        registry.delete(data.id);
      });
    },
    disposeOutputItem(id) {
      // if undefined, all cells are being removed
      let ids = id ? [id] : [...registry.keys()];
      for (let id of ids) {
        registry.get(id)?.unmount();
        registry.delete(id);
      }
    },
  };
};
