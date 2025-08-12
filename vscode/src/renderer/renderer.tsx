/// <reference lib="dom" />
import * as React from "react";
import * as ReactDOM from "react-dom/client";
import type { ActivationFunction } from "vscode-notebook-renderer";

import styleText from "virtual:injected-styles";
import { initializeMarimoComponents } from "./marimo-components.ts";

let { renderHTML } = initializeMarimoComponents();

const style = document.createElement("style");
// Hack to get styles copied into ShadowDOM by marimo's custom elements
style.dataset.viteDevId = "marimo-lsp-styles"
style.textContent = styleText;
document.head.appendChild(style);

export const activate: ActivationFunction<unknown> = async () => {
  let registry = new Map<string, ReactDOM.Root>();
  return {
    renderOutputItem(data, element, signal) {
      let root = ReactDOM.createRoot(element);
      root.render(
        <div className="p-4">
          {renderHTML({ html: data.text() })}
        </div>,
      );
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
