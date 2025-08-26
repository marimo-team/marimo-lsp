import {
  type CellRuntimeState,
  OutputRenderer,
  useTheme,
} from "./marimo-frontend.ts";

/**
 * Component that renders cell output based on the full runtime state.
 */
export function CellOutput({ state }: { state: CellRuntimeState }) {
  const { theme } = useTheme();
  return (
    <div className={`marimo-cell-output p-4 ${theme}`}>
      {state.output && <OutputRenderer message={state.output} />}
    </div>
  );
}
