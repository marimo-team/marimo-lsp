import type * as lsp from "vscode-languageclient";

import { Logger } from "./logging.ts";
import type { MarimoNotification, MarimoNotificationOf } from "./types.ts";

export function registerNotificationHandler<K extends MarimoNotification>(
  client: lsp.BaseLanguageClient,
  options: {
    method: K;
    callback: (message: MarimoNotificationOf<K>) => void;
    signal: AbortSignal;
  },
): void {
  const disposer = client.onNotification(
    options.method,
    (message: MarimoNotificationOf<K>) => {
      Logger.debug(
        "Notification.Received",
        `Received notification: ${options.method}`,
      );
      Logger.trace(
        "Notification.Received",
        `Message for ${options.method}`,
        message,
      );
      return Promise.resolve(options.callback(message))
        .then(() => {
          Logger.trace(
            "Notification.Handled",
            `Successfully handled: ${options.method}`,
          );
        })
        .catch((error) => {
          Logger.error(
            "Notification.Handler",
            `Handler failed for: ${options.method}`,
            error,
          );
          throw error;
        });
    },
  );
  options.signal.addEventListener("abort", () => {
    Logger.debug(
      "Notification.Unregister",
      `Unregistering handler for: ${options.method}`,
    );
    disposer.dispose();
  });
}
