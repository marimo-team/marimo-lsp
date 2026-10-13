/** @vitest-environment happy-dom */
import * as React from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { createRoot } from "../../src/renderer/pluginReactRoot.ts";
import { initializeOutputErrorReporting } from "../../src/renderer/reportOutputError.ts";
import type { RendererCommand } from "../../src/types.ts";

const failure = new TypeError(
  "Cannot read properties of undefined (reading 'read')",
);
function BrokenTable(): React.ReactNode {
  throw failure;
}
class Boundary extends React.Component<
  React.PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? "Something went wrong" : this.props.children;
  }
}

const roots: Root[] = [];
let messages: RendererCommand[];
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  messages = [];
  initializeOutputErrorReporting((message) => messages.push(message));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  React.act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderBroken(
  tag: string,
  parent: Node = document.body,
  caught = true,
) {
  const host = document.createElement(tag);
  parent.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const root = createRoot(shadow);
  roots.push(root);
  const render = caught ? React.act : flushSync;
  render(() =>
    root.render(
      caught
        ? React.createElement(Boundary, null, React.createElement(BrokenTable))
        : React.createElement(BrokenTable),
    ),
  );
  return shadow;
}

describe("marimo plugin error reporting", () => {
  it("reports a caught table failure even when its boundary renders a fallback", () => {
    const shadow = renderBroken("marimo-table");
    expect(shadow.textContent).toBe("Something went wrong");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      command: "report-output-error",
      params: {
        component: "marimo-table",
        name: "TypeError",
        message: failure.message,
        stack: failure.stack,
        componentStack: expect.stringContaining("BrokenTable"),
      },
    });
  });

  it("also reports uncaught built-in component failures", () => {
    renderBroken("marimo-table", document.body, false);
    expect(messages).toHaveLength(1);
  });

  it("excludes anywidget roots and built-ins nested inside their shadow DOM", () => {
    const widget = renderBroken("marimo-anywidget");
    renderBroken("marimo-table", widget);
    expect(messages).toEqual([]);
  });

  it("excludes arbitrary third-party roots", () => {
    renderBroken("custom-widget");
    expect(messages).toEqual([]);
  });

  it("deduplicates repeated failures across output remounts", () => {
    renderBroken("marimo-table");
    renderBroken("marimo-table");
    expect(messages).toHaveLength(1);
  });

  it("keeps the error fallback working when messaging fails", () => {
    initializeOutputErrorReporting(() => {
      throw new Error("disconnected");
    });
    expect(renderBroken("marimo-table").textContent).toBe(
      "Something went wrong",
    );
  });
});
