import { initializePlugins } from "@marimo-team/frontend/unstable_internal/plugins/plugins.ts";
import { renderHTML } from "@marimo-team/frontend/unstable_internal/plugins/core/RenderHTML.tsx";
import { store } from "@marimo-team/frontend/unstable_internal/core/state/jotai.ts";
import { requestClientAtom } from "@marimo-team/frontend/unstable_internal/core/network/requests.ts";
import { RuntimeState } from "@marimo-team/frontend/unstable_internal/core/kernel/RuntimeState.ts";
import type { EditRequests, RunRequests } from "@marimo-team/frontend/unstable_internal/core/network/types.ts";

import "@marimo-team/frontend/unstable_internal/css/common.css";
import "@marimo-team/frontend/unstable_internal/css/globals.css";
import "@marimo-team/frontend/unstable_internal/css/codehilite.css";
import "@marimo-team/frontend/unstable_internal/css/katex.min.css";
import "@marimo-team/frontend/unstable_internal/css/md.css";
import "@marimo-team/frontend/unstable_internal/css/admonition.css";
import "@marimo-team/frontend/unstable_internal/css/md-tooltip.css";
import "@marimo-team/frontend/unstable_internal/css/table.css";

export type RequestClient = EditRequests & RunRequests;

/**
 * Initialize marimo UI components in the VS Code renderer environment.
 * This provides a minimal setup to hydrate web components without the full kernel.
 */
export function initialize(client: RequestClient) {
  store.set(requestClientAtom, client);
  initializePlugins();
  // Start the RuntimeState to listen for UI element value changes
  // This connects the UI element events to the request client
  RuntimeState.INSTANCE.start(client.sendComponentValues);
  return renderHTML;
}
