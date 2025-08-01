import * as ReactDOM from "react-dom/client";
import type { ActivationFunction } from "vscode-notebook-renderer";

import { initializeMarimoComponents } from "./marimo-components.ts";

let { registry: uiRegistry, renderHTML } = initializeMarimoComponents();

export const activate: ActivationFunction<unknown> = async () => {
  let registry = new Map<string, ReactDOM.Root>();
  return {
    renderOutputItem(data, element, signal) {
      let root = ReactDOM.createRoot(element);
      root.render(
        renderHTML({ html: data.text() }),
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
