/// <reference lib="dom" />

import styleText from "virtual:stylesheet";
import * as ReactDOM from "react-dom/client";
import type * as vscode from "vscode-notebook-renderer";
import { CellOutput } from "./CellOutput.tsx";
import { type CellRuntimeState, initialize } from "./marimo-frontend.ts";
import { createRequestClient } from "./utils.ts";

export const activate: vscode.ActivationFunction = (context) => {
  const registry = new Map<HTMLElement, ReactDOM.Root>();
  const renderHTML = initialize(createRequestClient(context));

  // Inject the final compiled CSS from our Vite plugin
  // The title="marimo" tags these styles to be copied
  // into the ShadowDOM (for our UI elements).
  {
    const style = document.createElement("style");
    style.title = "marimo";
    style.textContent = styleText;
    document.head.appendChild(style);
  }

  return {
    renderOutputItem(data, element, signal) {
      const root = registry.get(element) ?? ReactDOM.createRoot(element);
      const state: CellRuntimeState = data.json();
      root.render(<CellOutput state={state} renderHTML={renderHTML} />);
      registry.set(element, root);
      signal.addEventListener("abort", () => {
        root.unmount();
        registry.delete(element);
      });
    },
  };
};
