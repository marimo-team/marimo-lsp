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

// @ts-expect-error
import { OutputRenderer as UntypedOutputRenderer } from "@marimo-team/frontend/unstable_internal/components/editor/Output.tsx?nocheck";
// @ts-expect-error
import { ConsoleOutput as UntypedConsoleOutput } from "@marimo-team/frontend/unstable_internal/components/editor/output/ConsoleOutput.tsx?nocheck";
// @ts-expect-error
import { TooltipProvider as UntypedTooltipProvider } from "@marimo-team/frontend/unstable_internal/components/ui/tooltip.tsx?nocheck";
import type { CellId } from "@marimo-team/frontend/unstable_internal/core/cells/ids.ts";
// @ts-expect-error
import { UI_ELEMENT_REGISTRY } from "@marimo-team/frontend/unstable_internal/core/dom/uiregistry.ts?nocheck";
// @ts-expect-error
import { RuntimeState } from "@marimo-team/frontend/unstable_internal/core/kernel/RuntimeState.ts?nocheck";
// @ts-expect-error
import { requestClientAtom } from "@marimo-team/frontend/unstable_internal/core/network/requests.ts?nocheck";
// @ts-expect-error
import { store } from "@marimo-team/frontend/unstable_internal/core/state/jotai.ts?nocheck";
import {
  handleWidgetMessage,
  isMessageWidgetState,
  MODEL_MANAGER,
  // @ts-expect-error
} from "@marimo-team/frontend/unstable_internal/plugins/impl/anywidget/model.ts?nocheck";
// @ts-expect-error
import { initializePlugins } from "@marimo-team/frontend/unstable_internal/plugins/plugins.ts?nocheck";
// @ts-expect-error
import { useTheme as untypedUseTheme } from "@marimo-team/frontend/unstable_internal/theme/useTheme.ts?nocheck";

import "@marimo-team/frontend/unstable_internal/css/common.css";
import "@marimo-team/frontend/unstable_internal/css/globals.css";
import "@marimo-team/frontend/unstable_internal/css/codehilite.css";
import "@marimo-team/frontend/unstable_internal/css/katex.min.css";
import "@marimo-team/frontend/unstable_internal/css/md.css";
import "@marimo-team/frontend/unstable_internal/css/admonition.css";
import "@marimo-team/frontend/unstable_internal/css/md-tooltip.css";
import "@marimo-team/frontend/unstable_internal/css/table.css";

import type { CellRuntimeState } from "../shared/cells.ts";
export type RequestClient = EditRequests & RunRequests;
export type { CellRuntimeState, CellId };

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
}

// vendored from https://github.com/marimo-team/marimo/blob/111b24f/frontend/src/core/websocket/useMarimoWebSocket.tsx#L110-L134
export function handleSendUiElementMessage(
  msg: MessageOperationOf<"send-ui-element-message">,
) {
  const modelId = msg.model_id;
  const uiElement = msg.ui_element;
  const message = msg.message;
  const buffers = msg.buffers ?? [];

  if (modelId && isMessageWidgetState(message)) {
    handleWidgetMessage({
      modelId,
      msg: message,
      buffers,
      modelManager: MODEL_MANAGER,
    });
  }

  if (uiElement) {
    UI_ELEMENT_REGISTRY.broadcastMessage(uiElement, message, buffers);
  }
}

export function handleRemoveUIElements(
  msg: MessageOperationOf<"remove-ui-elements">,
) {
  // This removes the element from the registry to (1) clean-up
  // memory and (2) make sure that the old value doesn't get re-used
  // if the same cell-id is later reused for another element.
  const cellId = msg.cell_id as CellId;
  UI_ELEMENT_REGISTRY.removeElementsByCell(cellId);
}

/* Type-safe wrapper around marimo's `useTheme` we import above */
export function useTheme(): { theme: "light" | "dark" } {
  return untypedUseTheme();
}

type OutputMessage = NonNullable<CellRuntimeState["output"]>;

export const OutputRenderer: React.FC<{
  message: OutputMessage;
  cellId?: CellId;
}> = UntypedOutputRenderer;

export const ConsoleOutput: React.FC<{
  cellId: CellId;
  cellName: string;
  consoleOutputs: Array<OutputMessage>;
  stale: boolean;
  debuggerActive: boolean;
  onSubmitDebugger: (text: string, index: number) => void;
}> = UntypedConsoleOutput;

export const TooltipProvider: React.FC<React.PropsWithChildren> =
  UntypedTooltipProvider;

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

import type { MessageOperationOf } from "../types.ts";
