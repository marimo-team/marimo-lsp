/// <reference lib="dom" />

import "./styles.css";
import styleText from "virtual:stylesheet";

import * as ReactDOM from "react-dom/client";
import type * as vscode from "vscode-notebook-renderer";
import { assert, unreachable } from "../assert.ts";
import { CellOutput } from "./CellOutput.tsx";
import {
  type CellId,
  type CellRuntimeState,
  handleFunctionCallResult,
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
