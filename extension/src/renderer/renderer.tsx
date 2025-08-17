/// <reference lib="dom" />

import styleText from "virtual:stylesheet";
import * as ReactDOM from "react-dom/client";
import type * as vscode from "vscode-notebook-renderer";
import { CellOutput } from "./CellOutput.tsx";
import { CellStateManager } from "./cellStateManager.ts";
import { type CellMessage, initialize } from "./marimo-frontend.ts";
import { createRequestClient } from "./utils.ts";

export const activate: vscode.ActivationFunction = (context) => {
  const registry: Map<HTMLElement, ReactDOM.Root> = new Map();
  const renderHTML = initialize(createRequestClient(context));
  const stateManager = new CellStateManager();

  // Inject the final compiled CSS from our Vite plugin
  // The title="marimo" tags these styles to be copied
  // into the ShadowDOM (for our UI elements).
  {
    const style = document.createElement("style");
    style.title = "marimo";
    style.textContent = styleText;
    document.head.appendChild(style);
  }

  context.onDidReceiveMessage?.((message) => {
    if (message.type === "cell-op") {
      const cellOp: CellMessage = message.data;
      const state = stateManager.handleCellOp(cellOp);
      for (const [element, root] of registry.entries()) {
        if (element.getAttribute("data-cell-id") === cellOp.cell_id) {
          root.render(
            <CellOutput
              state={state}
              message={cellOp}
              renderHTML={renderHTML}
            />,
          );
        }
      }
    }
  });

  return {
    renderOutputItem(data, element, signal) {
      const root = registry.get(element) ?? ReactDOM.createRoot(element);
      registry.set(element, root);
      const cellId = data.text();
      element.setAttribute("data-cell-id", cellId);
      stateManager.initializeCell(cellId);
      signal.addEventListener("abort", () => {
        element.removeAttribute("data-cell-id");
        registry.delete(element);
        root.unmount();
      });
    },
  };
};
