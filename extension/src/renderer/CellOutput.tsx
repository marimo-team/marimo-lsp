import * as React from "react";

import { ImageToolbar } from "./ImageToolbar.tsx";
import {
  type CellId,
  type CellRuntimeState,
  ConsoleOutput,
  OutputRenderer,
  TooltipProvider,
  useTheme,
} from "./marimo-frontend.ts";
import { useEventListener } from "./useEventListener.ts";

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
  const { target: hoveredImage, clear: clearHover } = useImageHover(container);

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
      {hoveredImage && (
        <ImageToolbar target={hoveredImage} onMouseLeave={clearHover} />
      )}
    </div>
  );
}

/**
 * Detect when the user hovers over an <img> inside the container.
 * Uses native DOM events via useEventListener so we can call stopPropagation.
 */
function useImageHover(ref: React.RefObject<HTMLDivElement | null>) {
  const [target, setTarget] = React.useState<HTMLImageElement | null>(null);
  const clear = React.useCallback(() => setTarget(null), []);

  useEventListener(ref, "mouseover", (e) => {
    const img = (e.target as HTMLElement).closest?.("img");
    if (img instanceof HTMLImageElement) {
      e.stopPropagation();
      setTarget(img);
    }
  });

  useEventListener(ref, "mouseout", (e) => {
    const related = e.relatedTarget as HTMLElement | null;
    if (related?.closest?.(".image-toolbar")) return;
    if ((e.target as HTMLElement).closest?.("img")) {
      e.stopPropagation();
      setTarget(null);
    }
  });

  return { target, clear };
}

/**
 * Prevent keyboard events from input elements from triggering VS Code
 * notebook shortcuts (like 'a' to add cell, 'x' to delete, etc.).
 *
 * Uses bubbling phase so inputs handle events first (e.g., Enter to submit),
 * then stops propagation to VS Code.
 */
function useStopInputKeyboardPropagation(
  ref: React.RefObject<HTMLDivElement | null>,
) {
  const handler = React.useCallback((e: KeyboardEvent) => {
    if (isFromInput(e)) {
      e.stopPropagation();
    }
  }, []);

  useEventListener(ref, "keydown", handler);
  useEventListener(ref, "keyup", handler);
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
