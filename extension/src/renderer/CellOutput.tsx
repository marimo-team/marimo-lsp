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

  useStopUnmodifiedInputKeys(container);

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
 * Stop typing keystrokes inside marimo inputs from reaching VS Code's notebook
 * keybindings (`a` insert-cell-above, `x` delete-cell, …). Ctrl/Cmd shortcuts
 * flow through so paste (#487), user remappings, and VS Code's own clipboard
 * handling keep working. `stopPropagation` (not `preventDefault`) leaves native
 * typing untouched.
 *
 * Alt-only combos are treated as typing: macOS Option-character entry
 * (Option+E → ´) and AltGr on international keyboards (reports as ctrl+alt
 * with `AltGraph` modifier) both produce characters, not commands.
 *
 * Modifier keys themselves (Control/Meta/Alt/Shift) always pass through so
 * VS Code sees their keyup and doesn't end up in a stuck-modifier state.
 *
 * This is a workaround. VS Code's webview preload already tracks input focus
 * inside outputs via `hasActiveEditableElement`, which recurses into shadow
 * roots matching `:read-write`, and sets the `notebookOutputInputFocused`
 * context key. That works for ipywidgets and raw HTML, but not for marimo:
 * every UI element is a custom element with `attachShadow({ mode: "open" })`
 * and the `<input>`/`<textarea>` lives in that shadow root.
 *
 * Proper fix — either side removes the need for this hook:
 *   - VS Code: make `hasActiveEditableElement` robust to editables nested in
 *     custom-element shadow roots.
 *   - marimo: expose a standard signal VS Code already recognizes — form-
 *     associated custom elements (host matches `:read-write`) or
 *     `delegatesFocus: true` on the shadow root.
 */
function useStopUnmodifiedInputKeys(
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const controller = new AbortController();
    const handler = (e: KeyboardEvent) => {
      if (isModifierKey(e.key)) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.getModifierState("AltGraph")) {
        return;
      }
      if (isFromInput(e)) {
        e.stopPropagation();
      }
    };

    container.addEventListener("keydown", handler, {
      signal: controller.signal,
    });
    container.addEventListener("keyup", handler, {
      signal: controller.signal,
    });

    return () => controller.abort();
  }, [containerRef]);
}

function isModifierKey(key: string): boolean {
  return (
    key === "Control" || key === "Meta" || key === "Alt" || key === "Shift"
  );
}

/**
 * Check if the keyboard event came from an input element, including across
 * shadow DOM boundaries (marimo UI elements are web components).
 */
function isFromInput(e: KeyboardEvent): boolean {
  const target = e.target;

  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName.startsWith("MARIMO") ||
      target.closest(".cm-editor") !== null)
  ) {
    return true;
  }

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
