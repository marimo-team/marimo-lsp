import * as ReactDOM from "react-dom/client";

import { reportOutputError } from "./reportOutputError.ts";

/**
 * Vite routes only marimo's registerReactComponent import through this adapter.
 * Its shadow roots are independent of CellOutput, so outer React error handlers
 * cannot see failures caught by the table's own error boundary.
 */
export const createRoot: typeof ReactDOM.createRoot = (container, options) => {
  if (!(container instanceof ShadowRoot)) {
    return ReactDOM.createRoot(container, options);
  }
  const report = (error: unknown, info: ReactDOM.ErrorInfo) => {
    reportOutputError(container.host, error, info.componentStack);
  };
  return ReactDOM.createRoot(container, {
    ...options,
    onCaughtError(error, info) {
      report(error, info);
      if (options?.onCaughtError) options.onCaughtError(error, info);
      else console.error(error);
    },
    onUncaughtError(error, info) {
      report(error, info);
      if (options?.onUncaughtError) options.onUncaughtError(error, info);
      else console.error(error);
    },
  });
};

export default { ...ReactDOM, createRoot };
