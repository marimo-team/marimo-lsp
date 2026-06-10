/// <reference lib="dom" />

import * as React from "react";

import { requestImageDataUri, requestImageSave } from "./imageTransport.ts";

interface ImageToolbarProps {
  /** The <img> element currently being hovered */
  target: HTMLImageElement;
  /** Called when the mouse leaves the toolbar itself */
  onMouseLeave: () => void;
}

/**
 * Floating toolbar that appears over images with Copy and Save actions.
 * Positioned at the top-right corner of the hovered image.
 */
export function ImageToolbar({ target, onMouseLeave }: ImageToolbarProps) {
  const [copied, setCopied] = React.useState(false);

  const rect = target.getBoundingClientRect();
  // Position relative to the nearest positioned ancestor (the output container)
  const parentRect = target
    .closest<HTMLElement>(".marimo-cell-output")
    ?.getBoundingClientRect();
  if (!parentRect) {
    return null;
  }

  const top = rect.top - parentRect.top + 4;
  const right = parentRect.right - rect.right + 4;

  return (
    <div
      className="image-toolbar"
      style={{ top, right }}
      onMouseLeave={(e) => {
        // Moving back onto the image it decorates isn't "leaving"; closing here
        // would make the toolbar flicker as the image's mouseover re-opens it.
        const next = e.relatedTarget;
        if (next instanceof Node && target.contains(next)) {
          return;
        }
        onMouseLeave();
      }}
    >
      <button
        type="button"
        title="Copy image to clipboard"
        onClick={() => {
          // Call clipboard.write synchronously so the click's user activation
          // is still live; the blob is resolved (possibly via a host round-trip)
          // inside the ClipboardItem promise.
          copyImageToClipboard(target.src)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {
              void navigator.clipboard.writeText(target.src).catch(() => {});
            });
        }}
      >
        {copied ? checkIcon : copyIcon}
      </button>
      <button
        type="button"
        title="Save image"
        onClick={() =>
          requestImageSave(target.src, suggestedFilename(target.src))
        }
      >
        {downloadIcon}
      </button>
    </div>
  );
}

function copyImageToClipboard(src: string): Promise<void> {
  return navigator.clipboard.write([
    new ClipboardItem({ "image/png": imageToPngBlob(src) }),
  ]);
}

/**
 * Rasterize an image to a PNG blob for the clipboard. Reads the pixels locally
 * when possible; for cross-origin images (whose canvas would taint) it asks the
 * host for the bytes as a same-origin data URI, then rasterizes that.
 */
function imageToPngBlob(src: string): Promise<Blob> {
  return imgSrcToBlob(src, "image/png").catch(() =>
    requestImageDataUri(src).then((dataUri) =>
      imgSrcToBlob(dataUri, "image/png"),
    ),
  );
}

function suggestedFilename(src: string): string {
  if (!src.startsWith("data:")) {
    try {
      const base = new URL(src).pathname.split("/").pop();
      if (base && /\.[^.]+$/.test(base)) {
        return decodeURIComponent(base);
      }
    } catch {
      // Not a parseable URL; fall through to a mime-derived name.
    }
  }
  return `image.${guessExtension(src)}`;
}

/**
 * Convert an image src (data URI or URL) to a Blob.
 * Uses canvas to ensure we get the requested format.
 */
function imgSrcToBlob(src: string, mimeType: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not get canvas context"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Could not create blob from canvas"));
        }
      }, mimeType);
    };
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

function guessExtension(src: string): string {
  const match = /^data:(image\/[^;,]+)/.exec(src);
  return (match && extensionForMime(match[1])) || "png";
}

function extensionForMime(mime: string): string | undefined {
  const match = /^image\/(.+)$/.exec(mime);
  if (!match) return undefined;
  const subtype = match[1];
  if (subtype === "svg+xml") return "svg";
  if (subtype === "jpeg") return "jpg";
  return subtype;
}

// Inline SVG icons (16x16, stroke-based) to avoid dependencies
const copyIcon = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
);

const checkIcon = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const downloadIcon = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);
