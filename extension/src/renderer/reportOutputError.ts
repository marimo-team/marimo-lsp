import type { RendererCommand } from "../types.ts";

let send: ((message: RendererCommand) => void) | undefined;
const reported = new Set<string>();
const MAX_REPORTS = 20;

export function initializeOutputErrorReporting(
  postMessage: (message: RendererCommand) => void,
) {
  send = postMessage;
  reported.clear();
}

/** Report built-in plugin failures, never arbitrary widget JavaScript. */
export function reportOutputError(
  host: Element,
  error: unknown,
  componentStack?: string,
) {
  if (!send || !host.localName.startsWith("marimo-")) return;
  // Walk across shadow boundaries as well as ordinary parents. A built-in
  // component embedded in an anywidget still belongs to that widget.
  let ancestor: Node | null = host;
  while (ancestor) {
    if (
      ancestor instanceof Element &&
      ancestor.localName === "marimo-anywidget"
    ) {
      return;
    }
    ancestor =
      ancestor instanceof ShadowRoot ? ancestor.host : ancestor.parentNode;
  }
  try {
    const params = {
      component: host.localName.slice(0, 100),
      name: (error instanceof Error ? error.name : "Error").slice(0, 100),
      message: (error instanceof Error
        ? error.message
        : "Non-Error thrown while rendering output"
      ).slice(0, 2000),
      stack: (error instanceof Error ? (error.stack ?? "") : "").slice(
        0,
        16000,
      ),
      componentStack: (componentStack ?? "").slice(0, 8000),
    };
    const key = JSON.stringify(params);
    if (reported.has(key) || reported.size >= MAX_REPORTS) return;
    reported.add(key);
    send({ command: "report-output-error", params });
  } catch {
    // Reporting must never interfere with the output's error fallback.
  }
}
