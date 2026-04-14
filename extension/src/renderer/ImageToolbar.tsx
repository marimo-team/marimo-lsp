/// <reference lib="dom" />

import * as React from "react";

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
      onMouseLeave={onMouseLeave}
    >
      <button
        type="button"
        title="Copy image to clipboard"
        onClick={async () => {
          await copyImageToClipboard(target);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? checkIcon : copyIcon}
      </button>
      <button
        type="button"
        title="Save image"
        onClick={() => saveImage(target)}
      >
        {downloadIcon}
      </button>
    </div>
  );
}

async function copyImageToClipboard(img: HTMLImageElement): Promise<void> {
  const src = img.src;

  // Try the modern Clipboard API with blob
  try {
    const blob = await imgSrcToBlob(src, "image/png");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return;
  } catch {
    // Fall back: copy the data URI as text
    await navigator.clipboard.writeText(src);
  }
}

function saveImage(img: HTMLImageElement): void {
  const src = img.src;
  const ext = guessExtension(src);
  const filename = `image.${ext}`;

  // Convert data URI to blob URL for reliable download
  imgSrcToBlob(src, `image/${ext}`)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    })
    .catch(() => {
      // Fallback: open in new tab
      const a = document.createElement("a");
      a.href = src;
      a.download = filename;
      a.click();
    });
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
  if (src.startsWith("data:image/")) {
    const mime = src.slice(11, src.indexOf(";"));
    if (mime === "svg+xml") return "svg";
    if (mime === "jpeg") return "jpg";
    return mime;
  }
  return "png";
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
