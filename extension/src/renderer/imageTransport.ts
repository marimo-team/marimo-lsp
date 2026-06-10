import type { RendererCommand } from "../types.ts";

/**
 * Bridge between the image toolbar (a React component deep in the output tree)
 * and the extension host. The renderer iframe is sandboxed and can't read
 * cross-origin image bytes, so saving and copying are delegated to the host
 * over the renderer messaging channel.
 *
 * `save-image` is fire-and-forget. `copy-image` is request/response: the host
 * replies with an `image-data-result` carrying the bytes as a data URI, matched
 * back to the caller by `requestId`.
 */

type PostMessage = (message: RendererCommand) => void;

let postMessage: PostMessage | undefined;
let nextRequestId = 0;

const pending = new Map<
  string,
  { resolve: (dataUri: string) => void; reject: (reason: Error) => void }
>();

const REQUEST_TIMEOUT_MS = 15_000;

export function initImageTransport(post: PostMessage): void {
  postMessage = post;
}

/** Route an `image-data-result` reply back to its pending `requestImageDataUri`. */
export function resolveImageDataResult(
  requestId: string,
  dataUri: string | null,
): void {
  const entry = pending.get(requestId);
  if (!entry) {
    return;
  }
  pending.delete(requestId);
  if (dataUri === null) {
    entry.reject(new Error("The extension host could not load the image"));
  } else {
    entry.resolve(dataUri);
  }
}

/** Ask the host to fetch `src` and return its bytes as a data URI. */
export function requestImageDataUri(src: string): Promise<string> {
  if (!postMessage) {
    return Promise.reject(new Error("Image transport is not initialized"));
  }
  const requestId = `image-${nextRequestId++}`;
  postMessage({ command: "copy-image", params: { src, requestId } });

  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(requestId)) {
        reject(new Error("Timed out waiting for image data from the host"));
      }
    }, REQUEST_TIMEOUT_MS);
  });
}

/** Ask the host to save `src` to disk via a native save dialog. */
export function requestImageSave(src: string, suggestedName: string): void {
  postMessage?.({ command: "save-image", params: { src, suggestedName } });
}
