import { Data, Effect, Option } from "effect";
import type * as vscode from "vscode";

import { VsCode } from "../platform/VsCode.ts";

export class ImageFetchError extends Data.TaggedError("ImageFetchError")<{
  cause: unknown;
}> {}

interface ImageBytes {
  bytes: Uint8Array;
  mime: string;
}

const DATA_URI = /^data:([^;,]+)(;base64)?,(.*)$/s;

export function decodeDataUri(src: string): ImageBytes | null {
  const match = DATA_URI.exec(src);
  if (!match) {
    return null;
  }
  const [, mime, base64, data] = match;
  const bytes = base64
    ? new Uint8Array(Buffer.from(data, "base64"))
    : new TextEncoder().encode(decodeURIComponent(data));
  return { bytes, mime };
}

/**
 * Read an image the renderer references. Data URIs are decoded locally;
 * anything else is fetched. The extension host has no CORS restriction, so this
 * reaches the remote URLs that the sandboxed renderer iframe can't read itself.
 */
export const resolveImageBytes = Effect.fn("resolveImageBytes")(function* (
  src: string,
) {
  const decoded = decodeDataUri(src);
  if (decoded) {
    return decoded;
  }
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(src, { signal }),
    catch: (cause) => new ImageFetchError({ cause }),
  });
  const buffer = yield* Effect.tryPromise({
    try: () => response.arrayBuffer(),
    catch: (cause) => new ImageFetchError({ cause }),
  });
  return {
    bytes: new Uint8Array(buffer),
    mime: response.headers.get("content-type") ?? "application/octet-stream",
  } satisfies ImageBytes;
});

export const resolveImageDataUri = Effect.fn("resolveImageDataUri")(function* (
  src: string,
) {
  const { bytes, mime } = yield* resolveImageBytes(src);
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
});

export const saveImageToDisk = Effect.fn("saveImageToDisk")(function* (
  src: string,
  suggestedName: string,
  notebookUri: vscode.Uri,
) {
  const code = yield* VsCode;
  const { bytes } = yield* resolveImageBytes(src);
  const saveUri = yield* code.window.showSaveDialog({
    title: "Save image",
    defaultUri: code.Uri.joinPath(notebookUri, "..", suggestedName),
    filters: { Images: ["png", "jpg", "jpeg", "gif", "svg", "webp"] },
  });
  if (Option.isNone(saveUri)) {
    return;
  }
  yield* code.workspace.fs.writeFile(saveUri.value, bytes);
});
