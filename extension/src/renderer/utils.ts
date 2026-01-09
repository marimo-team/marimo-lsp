import type * as vscode from "vscode-notebook-renderer";

import { assert } from "../assert.ts";
import type { RendererCommand, RendererReceiveMessage } from "../types.ts";
import type { RequestClient } from "./marimo-frontend.ts";

type TypedRequestContext = Omit<
  vscode.RendererContext<unknown>,
  "postMessage" | "onDidReceiveMessage"
> & {
  postMessage(options: RendererCommand): void;
  onDidReceiveMessage(listener: (e: RendererReceiveMessage) => unknown): {
    dispose(): void;
  };
};

export function isTypedRequestContext(
  context: vscode.RendererContext<unknown>,
): context is TypedRequestContext {
  return (
    typeof context.postMessage === "function" &&
    typeof context.onDidReceiveMessage === "function"
  );
}

export function createRequestClient(
  context: TypedRequestContext,
): RequestClient {
  assert(
    isTypedRequestContext(context),
    `Expected {"requiresMessaging": "always"} for marimo outputs.`,
  );

  const client = {
    async sendFunctionRequest(request) {
      context.postMessage({
        command: "invoke-function",
        params: request,
      });
      return null;
    },
    async sendComponentValues(request) {
      context.postMessage({
        command: "update-ui-element",
        params: request,
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
