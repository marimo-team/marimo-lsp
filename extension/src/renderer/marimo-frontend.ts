/**
 * @module
 *
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

import type {
  CellId,
  UIElementId,
} from "@marimo-team/frontend/unstable_internal/core/cells/ids.ts";
import { requestClientAtom } from "@marimo-team/frontend/unstable_internal/core/network/requests.ts";
import { store } from "@marimo-team/frontend/unstable_internal/core/state/jotai.ts";
import {
  handleWidgetMessage,
  isMessageWidgetState,
  MODEL_MANAGER,
} from "@marimo-team/frontend/unstable_internal/plugins/impl/anywidget/model.ts";
import { safeExtractSetUIElementMessageBuffers } from "@marimo-team/frontend/unstable_internal/utils/json/base64.ts";
// @ts-expect-error
import * as untyped from "./marimo-frontend-untyped.js";

export { useTheme } from "@marimo-team/frontend/unstable_internal/theme/useTheme.ts";

import "@marimo-team/frontend/unstable_internal/css/common.css";
import "@marimo-team/frontend/unstable_internal/css/globals.css";
import "@marimo-team/frontend/unstable_internal/css/codehilite.css";
import "@marimo-team/frontend/unstable_internal/css/katex.min.css";
import "@marimo-team/frontend/unstable_internal/css/md.css";
import "@marimo-team/frontend/unstable_internal/css/admonition.css";
import "@marimo-team/frontend/unstable_internal/css/md-tooltip.css";
import "@marimo-team/frontend/unstable_internal/css/table.css";

import type { CellRuntimeState } from "../shared/cells.ts";
import type { MessageOperationOf } from "../types.ts";

export type RequestClient = EditRequests & RunRequests;
export type { CellRuntimeState, CellId };

/**
 * Initialize marimo UI components in the VS Code renderer environment.
 * This provides a minimal setup to hydrate web components without the full kernel.
 */
export function initialize(client: RequestClient) {
  store.set(requestClientAtom, client);
  untyped.initializePlugins();
  // Start the RuntimeState to listen for UI element value changes
  // This connects the UI element events to the request client
  untyped.RuntimeState.INSTANCE.start(client.sendComponentValues);
}

// vendored from https://github.com/marimo-team/marimo/blob/111b24f/frontend/src/core/websocket/useMarimoWebSocket.tsx#L110-L134
export function handleSendUiElementMessage(
  msg: MessageOperationOf<"send-ui-element-message">,
) {
  const modelId = msg.model_id;
  const uiElement = msg.ui_element as UIElementId;
  const message = msg.message;
  const buffers = safeExtractSetUIElementMessageBuffers(msg);

  if (modelId && isMessageWidgetState(message)) {
    handleWidgetMessage({
      modelId,
      msg: message,
      buffers,
      modelManager: MODEL_MANAGER,
    });
  }

  if (uiElement) {
    untyped.UI_ELEMENT_REGISTRY.broadcastMessage(uiElement, message, buffers);
  }
}

export function handleRemoveUIElements(
  msg: MessageOperationOf<"remove-ui-elements">,
) {
  // This removes the element from the registry to (1) clean-up
  // memory and (2) make sure that the old value doesn't get re-used
  // if the same cell-id is later reused for another element.
  const cellId = msg.cell_id as CellId;
  untyped.UI_ELEMENT_REGISTRY.removeElementsByCell(cellId);
}

type OutputMessage = NonNullable<CellRuntimeState["output"]>;

export const OutputRenderer: React.FC<{
  message: OutputMessage;
  cellId?: CellId;
}> = untyped.OutputRenderer;

export const ConsoleOutput: React.FC<{
  cellId: CellId;
  cellName: string;
  consoleOutputs: Array<OutputMessage>;
  stale: boolean;
  debuggerActive: boolean;
  onSubmitDebugger: (text: string, index: number) => void;
}> = untyped.ConsoleOutput;

export const TooltipProvider: React.FC<React.PropsWithChildren> =
  untyped.TooltipProvider;

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
