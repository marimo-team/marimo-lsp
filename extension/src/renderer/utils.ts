import type * as vscode from "vscode-notebook-renderer";

import { assert } from "../assert.ts";
import type { RequestMap } from "../types.ts";
import type { RequestClient } from "./marimo-frontend.ts";

type TypedRequestContext = Omit<
  vscode.RendererContext<unknown>,
  "postMessage" | "onDidReceiveMessage"
> & {
  postMessage<K extends keyof RequestMap>(options: {
    command: K;
    params: Omit<RequestMap[K], "notebookUri">;
  }): void;
  onDidReceiveMessage(listener: (e: unknown) => unknown): { dispose(): void };
};

function isTypedRequestContext(
  context: vscode.RendererContext<unknown>,
): context is TypedRequestContext {
  return (
    typeof context.postMessage === "function" &&
    typeof context.onDidReceiveMessage === "function"
  );
}

export function createRequestClient(
  context: vscode.RendererContext<unknown>,
): RequestClient {
  assert(
    isTypedRequestContext(context),
    `Expected {"requiresMessaging": "always"} for marimo outputs.`,
  );

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
