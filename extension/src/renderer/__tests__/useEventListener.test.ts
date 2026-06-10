/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEventListener } from "../useEventListener.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Required by React 19's `act` to confirm it runs in a test environment.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface ProbeProps {
  targetRef: React.RefObject<HTMLElement | null>;
  event: keyof HTMLElementEventMap;
  handler: (e: Event) => void;
  options?: boolean | AddEventListenerOptions;
}

function Probe({ targetRef, event, handler, options }: ProbeProps) {
  useEventListener(targetRef, event, handler, options);
  return null;
}

let root: Root;
let mount: HTMLElement;

beforeEach(() => {
  mount = document.createElement("div");
  document.body.appendChild(mount);
  root = createRoot(mount);
});

afterEach(() => {
  act(() => root.unmount());
  mount.remove();
});

function render(props: ProbeProps) {
  act(() => root.render(React.createElement(Probe, props)));
}

describe("useEventListener", () => {
  it("attaches the listener to the ref'd element", () => {
    const el = document.createElement("div");
    const spy = vi.spyOn(el, "addEventListener");

    render({ targetRef: { current: el }, event: "click", handler: vi.fn() });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("invokes the handler when the event fires", () => {
    const el = document.createElement("div");
    const handler = vi.fn();

    render({ targetRef: { current: el }, event: "click", handler });
    el.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("removes the listener on unmount", () => {
    const el = document.createElement("div");
    const handler = vi.fn();

    render({ targetRef: { current: el }, event: "click", handler });
    act(() => root.unmount());
    el.click();

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not throw when the ref is null", () => {
    expect(() =>
      render({
        targetRef: { current: null },
        event: "click",
        handler: vi.fn(),
      }),
    ).not.toThrow();
  });

  it("forwards a boolean option as capture", () => {
    const el = document.createElement("div");
    const spy = vi.spyOn(el, "addEventListener");

    render({
      targetRef: { current: el },
      event: "keydown",
      handler: vi.fn(),
      options: true,
    });

    expect(spy).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      expect.objectContaining({ capture: true }),
    );
  });

  it("calls the latest handler without re-subscribing when only the handler changes", () => {
    const el = document.createElement("div");
    const spy = vi.spyOn(el, "addEventListener");
    const ref = { current: el };
    const first = vi.fn();
    const second = vi.fn();

    render({ targetRef: ref, event: "click", handler: first });
    render({ targetRef: ref, event: "click", handler: second });

    expect(spy).toHaveBeenCalledOnce();

    el.click();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("re-subscribes and drops the old listener when the event type changes", () => {
    const el = document.createElement("div");
    const ref = { current: el };
    const handler = vi.fn();

    render({ targetRef: ref, event: "mouseover", handler });
    render({ targetRef: ref, event: "click", handler });

    el.dispatchEvent(new Event("mouseover"));
    expect(handler).not.toHaveBeenCalled();

    el.click();
    expect(handler).toHaveBeenCalledOnce();
  });
});
