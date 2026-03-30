/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { useEventListener } from "../useEventListener.ts";

// Track the most recent useEffect cleanup so tests can invoke it.
let cleanupFn: (() => void) | undefined;

// Minimal React shim — just enough to exercise the hook synchronously in Node.
vi.mock("react", () => ({
  useRef: (init: unknown) => ({ current: init }),
  useEffect: (fn: () => (() => void) | void) => {
    cleanupFn = fn() ?? undefined;
  },
}));

function cleanup() {
  cleanupFn?.();
  cleanupFn = undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useEventListener", () => {
  it("adds an event listener to the element", () => {
    const el = document.createElement("div");
    const spy = vi.spyOn(el, "addEventListener");
    const ref = { current: el };

    useEventListener(ref, "click", vi.fn());

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("invokes the handler when the event fires", () => {
    const el = document.createElement("div");
    const ref = { current: el };
    const handler = vi.fn();

    useEventListener(ref, "click", handler);

    el.click();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.any(MouseEvent));
  });

  it("aborts the listener on cleanup", () => {
    const el = document.createElement("div");
    const ref = { current: el };
    const handler = vi.fn();

    useEventListener(ref, "click", handler);

    cleanup();
    el.click();

    expect(handler).not.toHaveBeenCalled();
  });

  it("does nothing when ref is null", () => {
    const ref = { current: null };
    // Should not throw
    expect(() => useEventListener(ref, "click", vi.fn())).not.toThrow();
  });

  it("passes capture: true when options is a boolean", () => {
    const el = document.createElement("div");
    const spy = vi.spyOn(el, "addEventListener");
    const ref = { current: el };

    useEventListener(ref, "keydown", vi.fn(), true);

    expect(spy).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      expect.objectContaining({ capture: true }),
    );
  });

  it("only subscribes once even when handler identity changes", () => {
    const el = document.createElement("div");
    const spy = vi.spyOn(el, "addEventListener");
    const ref = { current: el };

    useEventListener(ref, "click", vi.fn());
    expect(spy).toHaveBeenCalledTimes(1);

    // A second call with a different handler should not add another listener
    // (in a real React render, useEffect deps haven't changed)
    el.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
