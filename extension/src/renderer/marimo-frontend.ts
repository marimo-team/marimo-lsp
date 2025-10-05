/**
 * @module
 *
 * Type-safe imports from @marimo-team/frontend
 *
 * See marimo-frontend-untyped.js for details on why this split exists.
 */
// @ts-expect-error - Untyped imports that would fail type-checking. See marimo-frontend-untyped.js.

// biome-ignore assist/source/organizeImports: Keep untyped imports at the top
import * as untyped from "./marimo-frontend-untyped.js";

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
import type {
  CellId,
  UIElementId,
} from "@marimo-team/frontend/unstable_internal/core/cells/ids.ts";
import type { RequestId } from "../../../../marimo/frontend/src/core/network/DeferredRequestRegistry.ts";
import { requestClientAtom } from "@marimo-team/frontend/unstable_internal/core/network/requests.ts";
import { store } from "@marimo-team/frontend/unstable_internal/core/state/jotai.ts";
import {
  handleWidgetMessage,
  isMessageWidgetState,
  MODEL_MANAGER,
} from "@marimo-team/frontend/unstable_internal/plugins/impl/anywidget/model.ts";
import { FUNCTIONS_REGISTRY } from "@marimo-team/frontend/unstable_internal/core/functions/FunctionRegistry.ts";
import { safeExtractSetUIElementMessageBuffers } from "@marimo-team/frontend/unstable_internal/utils/json/base64.ts";

import "@marimo-team/frontend/unstable_internal/css/common.css";
import "@marimo-team/frontend/unstable_internal/css/globals.css";
import "@marimo-team/frontend/unstable_internal/css/codehilite.css";
import "@marimo-team/frontend/unstable_internal/css/katex.min.css";
import "@marimo-team/frontend/unstable_internal/css/md.css";
import "@marimo-team/frontend/unstable_internal/css/admonition.css";
import "@marimo-team/frontend/unstable_internal/css/md-tooltip.css";
import "@marimo-team/frontend/unstable_internal/css/table.css";

import type { MessageOperationOf, CellRuntimeState } from "../types.ts";

export { useTheme } from "@marimo-team/frontend/unstable_internal/theme/useTheme.ts";

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

export function handleFunctionCallResult(
  msg: MessageOperationOf<"function-call-result">,
) {
  FUNCTIONS_REGISTRY.resolve(msg.function_call_id as RequestId, msg);
  return;
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
