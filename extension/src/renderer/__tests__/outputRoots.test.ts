/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { OutputRoots } from "../outputRoots.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Required by React 19's `act` to confirm it runs in a test environment.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ label }: { label: string }) {
  return React.createElement("span", { "data-probe": true }, label);
}

let roots: OutputRoots;

afterEach(() => {
  act(() => roots.dispose());
});

describe("OutputRoots", () => {
  it("re-renders into the same root and keeps DOM nodes across updates", () => {
    roots = new OutputRoots();
    const element = document.createElement("div");

    const first = roots.acquire("out-1", element);
    act(() => first.render(React.createElement(Probe, { label: "a" })));
    const node = element.querySelector("span");
    expect(node?.textContent).toBe("a");

    // Simulates VS Code re-invoking `renderOutputItem` for an updated item.
    const second = roots.acquire("out-1", element);
    act(() => second.render(React.createElement(Probe, { label: "b" })));

    // Same node, new content: React reconciled instead of remounting.
    expect(element.querySelector("span")).toBe(node);
    expect(node?.textContent).toBe("b");
  });

  it("replaces the root when the same id arrives on a new element", () => {
    roots = new OutputRoots();
    const stale = document.createElement("div");
    const fresh = document.createElement("div");

    const first = roots.acquire("out-1", stale);
    act(() => first.render(React.createElement(Probe, { label: "a" })));

    const second = roots.acquire("out-1", fresh);
    act(() => second.render(React.createElement(Probe, { label: "b" })));

    // The stale element's tree was unmounted, not left dangling.
    expect(stale.querySelector("span")).toBeNull();
    expect(fresh.querySelector("span")?.textContent).toBe("b");
  });

  it("disposes one id or every id", () => {
    roots = new OutputRoots();
    const a = document.createElement("div");
    const b = document.createElement("div");
    act(() => {
      roots.acquire("a", a).render(React.createElement(Probe, { label: "a" }));
      roots.acquire("b", b).render(React.createElement(Probe, { label: "b" }));
    });

    act(() => roots.dispose("a"));
    expect(a.querySelector("span")).toBeNull();
    expect(b.querySelector("span")?.textContent).toBe("b");

    act(() => roots.dispose());
    expect(b.querySelector("span")).toBeNull();
  });
});
