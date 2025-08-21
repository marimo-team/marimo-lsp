import type * as React from "react";
import { type CellRuntimeState, useTheme } from "./marimo-frontend.ts";

interface CellOutputProps {
  state: CellRuntimeState;
  renderHTML: (props: { html: string }) => React.ReactNode;
}

/**
 * Component that renders cell output based on the full runtime state.
 * Handles different output types including HTML, errors, console outputs, and status indicators.
 */
export function CellOutput({ state, renderHTML }: CellOutputProps) {
  const { theme } = useTheme();
  const { output } = state;
  return (
    <div className={`marimo-cell-output ${theme}`}>
      {output && (
        <div className="cell-main-output p-4">
          {renderHTML({ html: String(output.data) })}
        </div>
      )}
    </div>
  );
}
