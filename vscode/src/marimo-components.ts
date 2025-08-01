import { initializePlugins } from "@marimo-team/frontend/plugins/plugins.ts";
import { initializeUIElement } from "@marimo-team/frontend/core/dom/ui-element.ts";
import { UI_ELEMENT_REGISTRY } from "@marimo-team/frontend/core/dom/uiregistry.ts";
import { renderHTML } from "@marimo-team/frontend/plugins/core/RenderHTML.tsx";

/**
 * Initialize marimo UI components in the VS Code renderer environment.
 * This provides a minimal setup to hydrate web components without the full kernel.
 */
export function initializeMarimoComponents() {
  initializePlugins();
  initializeUIElement();
  return {
    registry: UI_ELEMENT_REGISTRY,
    renderHTML,
  };
}
