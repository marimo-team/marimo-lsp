// @ts-expect-error
import { RuntimeState } from "@marimo-team/frontend/unstable_internal/core/kernel/RuntimeState.ts?nocheck";
// @ts-expect-error
import { requestClientAtom } from "@marimo-team/frontend/unstable_internal/core/network/requests.ts?nocheck";
/**
 * Type imports from @marimo-team/frontend
 *
 * These network types are imported WITHOUT ?nocheck because they're the most
 * likely to change as the API evolves. By keeping these type-checked, we ensure
 * our RequestClient interface stays in sync with marimo's actual API contracts.
 * Type errors here indicate breaking changes we need to handle.
 */
import type {
  EditRequests,
  RunRequests,
} from "@marimo-team/frontend/unstable_internal/core/network/types.ts";
// @ts-expect-error
import { store } from "@marimo-team/frontend/unstable_internal/core/state/jotai.ts?nocheck";
// @ts-expect-error
import { renderHTML } from "@marimo-team/frontend/unstable_internal/plugins/core/RenderHTML.tsx?nocheck";
/**
 * Runtime imports from @marimo-team/frontend
 *
 * Since @marimo-team/frontend doesn't emit .d.ts files, TypeScript attempts to
 * compile the entire frontend source when these modules are imported. There's no
 * way to skipLibCheck for specific packages, which would require our TypeScript
 * config to match marimo's exactly and type-check the entire frontend codebase.
 *
 * As a workaround, we use ?nocheck to disable type-checking for these specific
 * runtime imports. This should be used sparingly - we keep the exports of this
 * module minimal to maintain a clear, type-safe boundary.
 */
// @ts-expect-error
import { initializePlugins } from "@marimo-team/frontend/unstable_internal/plugins/plugins.ts?nocheck";
import type * as React from "react";

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
export function initialize(
  client: RequestClient,
): (props: { html: string }) => React.ReactNode {
  store.set(requestClientAtom, client);
  initializePlugins();
  // Start the RuntimeState to listen for UI element value changes
  // This connects the UI element events to the request client
  RuntimeState.INSTANCE.start(client.sendComponentValues);
  return renderHTML;
}

// export { transitionCell } from "@marimo-team/frontend/unstable_internal/core/cells/cell.ts"
// export { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts"
