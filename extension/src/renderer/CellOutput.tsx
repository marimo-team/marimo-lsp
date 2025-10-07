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
  return (
    <div className={`marimo-cell-output p-4 ${theme}`}>
      <TooltipProvider>
        {state.output && (
          <OutputRenderer cellId={cellId} message={state.output} />
        )}
      </TooltipProvider>
    </div>
  );
}
