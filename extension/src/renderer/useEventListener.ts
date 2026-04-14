/// <reference lib="dom" />

import * as React from "react";

/**
 * Attach a DOM event listener to a ref'd element with automatic cleanup.
 *
 * - Re-attaches when the element, event type, or options change.
 * - Always sees the latest handler without re-subscribing (via ref).
 * - Cleans up with AbortController on unmount or dependency change.
 */
export function useEventListener<
  K extends keyof HTMLElementEventMap,
  T extends HTMLElement = HTMLElement,
>(
  ref: React.RefObject<T | null>,
  event: K,
  handler: (e: HTMLElementEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
) {
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const controller = new AbortController();
    const opts =
      typeof options === "boolean"
        ? { capture: options, signal: controller.signal }
        : { ...options, signal: controller.signal };

    el.addEventListener(event, (e) => handlerRef.current(e), opts);

    return () => controller.abort();
  }, [ref, event, options]);
}
