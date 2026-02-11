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

  useStopInputKeyboardPropagation(container);

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

/**
 * Prevent keyboard events from input elements from triggering VS Code
 * notebook shortcuts (like 'a' to add cell, 'x' to delete, etc.).
 *
 * Uses bubbling phase so inputs handle events first (e.g., Enter to submit),
 * then stops propagation to VS Code.
 */
function useStopInputKeyboardPropagation(
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  React.useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const controller = new AbortController();
    const handler = (e: KeyboardEvent) => {
      if (isFromInput(e)) {
        e.stopPropagation();
      }
    };

    containerRef.current.addEventListener("keydown", handler, {
      signal: controller.signal,
    });
    containerRef.current.addEventListener("keyup", handler, {
      signal: controller.signal,
    });

    return () => controller.abort();
  }, [containerRef]);
}

/**
 * Check if the keyboard event came from an input element.
 *
 * Mirrors marimo's Events.fromInput() logic, with additional handling for
 * shadow DOM since marimo UI elements are rendered as web components.
 */
function isFromInput(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement;

  // Direct check (mirrors marimo's Events.fromInput)
  if (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName.startsWith("MARIMO") ||
    target.closest(".cm-editor") !== null
  ) {
    return true;
  }

  // Check shadow DOM for the actual focused element
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }

  if (active instanceof HTMLElement) {
    return (
      active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.tagName === "SELECT" ||
      active.isContentEditable ||
      active.closest(".cm-editor") !== null
    );
  }

  return false;
}
