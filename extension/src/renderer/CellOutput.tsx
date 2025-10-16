import { useRef } from "react";
import {
  type CellId,
  type CellRuntimeState,
  OutputRenderer,
  TooltipProvider,
  useTheme,
} from "./marimo-frontend.ts";

interface CellOutputProps {
  cellId: CellId;
  state: CellRuntimeState;
}

/**
 * Component that renders cell output based on the full runtime state.
 */
export function CellOutput({ cellId, state }: CellOutputProps) {
  const { theme } = useTheme();
  const container = useRef<HTMLDivElement>(null);

  return (
    <div
      className={`marimo-cell-output p-4 pt-6 ${theme}`}
      data-vscode-output-container="true"
      ref={container}
    >
      <TooltipProvider container={container.current}>
        {state.output && (
          <OutputRenderer cellId={cellId} message={state.output} />
        )}
      </TooltipProvider>
    </div>
  );
}
