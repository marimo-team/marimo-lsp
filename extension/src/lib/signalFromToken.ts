import type * as vscode from "vscode";

export function signalFromToken(token: vscode.CancellationToken) {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  token.onCancellationRequested(() => {
    controller.abort();
  });
  return controller.signal;
}
