/// <reference lib="dom" />

import "./styles.css";
import type * as vscode from "vscode-notebook-renderer";

import * as ReactDOM from "react-dom/client";
import styleText from "virtual:stylesheet";

import type { MarimoHtmlPublishMessage } from "../types.ts";

import { assert, unreachable } from "../assert.ts";
import { CellOutput } from "./CellOutput.tsx";
import {
  type CellId,
  type CellRuntimeState,
  handleFunctionCallResult,
  handleModelLifecycle,
  handleRemoveUIElements,
  handleSendUiElementMessage,
  initialize,
} from "./marimo-frontend.ts";
import { createRequestClient, isTypedRequestContext } from "./utils.ts";

export const activate: vscode.ActivationFunction = (context) => {
  assert(
    isTypedRequestContext(context),
    `Expected {"requiresMessaging": "always"} for marimo outputs.`,
  );

  initialize(createRequestClient(context));

  /**
   * Bridge for HTML output interactions.
   *
   * Notebook cell output HTML runs in an isolated context and can't directly execute VSCode
   * commands or access the notebook editor. To enable interactive elements (like clickable
   * cell references in error messages), we:
   *
   * 1. Embed onclick handlers in the HTML that post messages to window.parent
   * 2. Catch those messages here in the renderer
   * 3. Forward them to the extension via context.postMessage()
   * 4. The extension handles them in KernelManager.ts
   *
   * This enables features like "This variable was defined in [cell-2]" where clicking
   * "cell-2" navigates to that cell in the notebook.
   */
  window.addEventListener(
    "message",
    (event: MessageEvent<MarimoHtmlPublishMessage>) => {
      switch (event.data.command) {
        case "navigate-to-cell":
          context.postMessage(event.data);
          break;
        default:
          unreachable(
            event.data.command,
            `Unhandled HTML publish message: ${JSON.stringify(event.data)}`,
          );
      }
    },
  );

  context.onDidReceiveMessage((msg) => {
    switch (msg.op) {
      case "send-ui-element-message": {
        handleSendUiElementMessage(msg);
        return;
      }
      case "remove-ui-elements": {
        handleRemoveUIElements(msg);
        return;
      }
      case "function-call-result": {
        handleFunctionCallResult(msg);
        return;
      }
      case "model-lifecycle": {
        handleModelLifecycle(msg);
        return;
      }
      default: {
        unreachable(
          msg,
          `Unhandled message from VS Code extension: ${JSON.stringify(msg)}`,
        );
      }
    }
  });

  // Inject the final compiled CSS from our Vite plugin
  // The title="marimo" tags these styles to be copied
  // into the ShadowDOM (for our UI elements).
  {
    const style = document.createElement("style");
    style.title = "marimo";
    style.textContent = styleText;
    document.head.appendChild(style);
  }

  const registry = new Map<HTMLElement, ReactDOM.Root>();

  return {
    renderOutputItem(data, element, signal) {
      const root = registry.get(element) ?? ReactDOM.createRoot(element);
      const { cellId, state }: { cellId: CellId; state: CellRuntimeState } =
        data.json();
      root.render(<CellOutput cellId={cellId} state={state} />);
      registry.set(element, root);
      signal.addEventListener("abort", () => {
        root.unmount();
        registry.delete(element);
      });
    },
  };
};
