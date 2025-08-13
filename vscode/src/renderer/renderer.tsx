/// <reference lib="dom" />
import * as ReactDOM from "react-dom/client";
import type * as vscode from "vscode-notebook-renderer";
import styleText from "virtual:stylesheet";

import { assert } from "../assert.ts";
import { initialize, type RequestClient } from "./marimo-frontend.ts";
import type { RequestMap } from "../types.ts";


export const activate = defineActivationFunction((context) => {
  // Inject the final compiled CSS from our Vite plugin
  // The title="marimo" tags these styles to be copied
  // into the ShadowDOM (for our UI elements).
  {
    const style = document.createElement("style");
    style.title = "marimo";
    style.textContent = styleText;
    document.head.appendChild(style);
  }

  let renderHTML = initialize(createRequestClient(context));
  return {
    renderOutputItem(data, element, signal) {
      let html = data.text();
      let root = ReactDOM.createRoot(element);
      root.render(
        <div className="p-4">{renderHTML({ html })}</div>,
      );
      signal.addEventListener("abort", () => {
        root.unmount();
      });
    },
  };
});

function createRequestClient(context: TypedRequestContext): RequestClient {
  const client = {
    async sendComponentValues(request) {
      context.postMessage({
        command: "marimo.set_ui_element_value",
        // FIXME: The token is required by "set_ui_element_value" (but not needed)
        params: { ...request, token: "" },
      });
      return null;
    },
  } satisfies Partial<RequestClient>;
  return new Proxy(client as RequestClient, {
    get(target: RequestClient, p: string, receiver: unknown) {
      const method = Reflect.get(target, p, receiver);
      if (method === undefined) {
        return () => {
          throw new Error(`Not implemented: ${p}`);
        };
      }
      return method;
    },
  });
}

type TypedRequestContext =
  & Omit<vscode.RendererContext<unknown>, "postMessage" | "onDidReceiveMessage">
  & {
    postMessage<K extends keyof RequestMap>(
      options: { command: K; params: Omit<RequestMap[K], "notebookUri"> },
    ): void;
    onDidReceiveMessage(listener: (e: unknown) => any): { dispose(): void };
  };

function defineActivationFunction(
  activate: (context: TypedRequestContext) => vscode.RendererApi,
): vscode.ActivationFunction {
  return (context) => {
    assert(
      isTypedRequestContext(context),
      `Expected {"requiresMessaging": "always"} for marimo outputs.`,
    );
    return activate(context);
  };
}

function isTypedRequestContext(
  context: vscode.RendererContext<unknown>,
): context is TypedRequestContext {
  return (
    typeof context.postMessage === "function" &&
    typeof context.onDidReceiveMessage === "function"
  );
}
