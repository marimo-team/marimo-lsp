import * as React from "react";
import {
  type CellId,
  type CellRuntimeState,
  ConsoleOutput,
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
  const container = React.useRef<HTMLDivElement>(null);

  return (
    <div
      className={`marimo-cell-output p-4 pb-8 ${theme}`}
      data-vscode-output-container="true"
      ref={container}
    >
      <TooltipProvider container={container.current}>
        {state.output && (
          <OutputRenderer cellId={cellId} message={state.output} />
        )}
        {state.consoleOutputs && state.consoleOutputs.length > 0 && (
          <ConsoleOutput
            cellId={cellId}
            consoleOutputs={state.consoleOutputs}
            debuggerActive={false}
            onSubmitDebugger={() => {}}
            stale={false}
            cellName={""}
          />
        )}
      </TooltipProvider>
    </div>
  );
}
