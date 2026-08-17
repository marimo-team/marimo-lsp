/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from "vite-plus/test";

import { suppressEmbeddedErrorDialog } from "../suppressEmbeddedErrorDialog.ts";

function dispatchClick(className: string) {
  const output = document.createElement("div");
  const host = document.createElement("marimo-mermaid");
  const shadowRoot = host.attachShadow({ mode: "open" });
  const banner = document.createElement("div");
  const message = document.createElement("span");
  const onBannerClick = vi.fn();

  banner.className = className;
  banner.appendChild(message);
  shadowRoot.appendChild(banner);
  output.appendChild(host);
  output.addEventListener("click", suppressEmbeddedErrorDialog, {
    capture: true,
  });
  banner.addEventListener("click", onBannerClick);

  message.dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true }),
  );
  return onBannerClick;
}

describe("suppressEmbeddedErrorDialog", () => {
  it("stops clicks inside marimo error banners", () => {
    const onBannerClick = dispatchClick(
      "cursor-pointer text-error border shadow-error",
    );

    expect(onBannerClick).not.toHaveBeenCalled();
  });

  it("does not stop unrelated clickable content", () => {
    const onBannerClick = dispatchClick("cursor-pointer text-error border");

    expect(onBannerClick).toHaveBeenCalledOnce();
  });
});
