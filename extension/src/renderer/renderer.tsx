/// <reference lib="dom" />

import styleText from "virtual:stylesheet";
import * as ReactDOM from "react-dom/client";
import type * as vscode from "vscode-notebook-renderer";

import { initialize } from "./marimo-frontend.ts";
import { createRequestClient } from "./utils.ts";

export const activate: vscode.ActivationFunction = (context) => {
  const registry: Map<HTMLElement, ReactDOM.Root> = new Map();
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
      registry.set(element, root);
      root.render(
        <div className="p-4">{renderHTML({ html: data.text() })}</div>,
      );
      signal.addEventListener("abort", () => {
        registry.delete(element);
        root.unmount();
      });
    },
  };
};
