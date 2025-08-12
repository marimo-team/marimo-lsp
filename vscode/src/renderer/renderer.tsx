/// <reference lib="dom" />
import * as React from "react";
import * as ReactDOM from "react-dom/client";
import type { ActivationFunction } from "vscode-notebook-renderer";

import styleText from "virtual:injected-styles";
import { initializeMarimoComponents } from "./marimo-components.ts";

let { renderHTML } = initializeMarimoComponents();

// Inject the final compiled CSS from our Vite plugin
// The title="marimo" tags these styles to be copied
// into the ShadowDOM (for our UI elements).
{
  const sheet = document.createElement("style");
  sheet.title = "marimo";
  sheet.textContent = styleText;
  document.head.appendChild(sheet);
}

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
