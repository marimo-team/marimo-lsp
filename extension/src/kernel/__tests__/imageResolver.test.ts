import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeDataUri,
  ImageFetchError,
  resolveImageBytes,
} from "../imageResolver.ts";

describe("decodeDataUri", () => {
  it("decodes a base64 data URI", () => {
    // "hi" base64-encoded
    const result = decodeDataUri("data:image/png;base64,aGk=");
    expect(result).not.toBeNull();
    expect(result?.mime).toBe("image/png");
    expect(new TextDecoder().decode(result?.bytes)).toBe("hi");
  });

  it("decodes a non-base64 (url-encoded) data URI", () => {
    const result = decodeDataUri("data:image/svg+xml,%3Csvg%2F%3E");
    expect(result?.mime).toBe("image/svg+xml");
    expect(new TextDecoder().decode(result?.bytes)).toBe("<svg/>");
  });

  it("returns null for a non-data URL", () => {
    expect(decodeDataUri("https://example.com/a.svg")).toBeNull();
  });

  it("returns null for malformed percent-encoding", () => {
    expect(decodeDataUri("data:image/svg+xml,%")).toBeNull();
  });
});

describe("resolveImageBytes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Effect.flip moves the error onto the success channel so we can assert on it;
  // if the effect unexpectedly succeeds, flip fails the run and the test fails.
  const expectError = (src: string) =>
    Effect.runPromise(Effect.flip(resolveImageBytes(src)));

  it("rejects unsupported URL schemes before fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const error = await expectError("file:///etc/passwd");
    expect(error).toBeInstanceOf(ImageFetchError);
    expect(String(error.cause)).toContain("unsupported URL scheme");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects non-OK responses without reading the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not found", { status: 404, statusText: "Not Found" }),
      ),
    );
    const error = await expectError("https://example.com/missing.png");
    expect(error).toBeInstanceOf(ImageFetchError);
    expect(String(error.cause)).toContain("404");
  });

  it("rejects non-image content types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const error = await expectError("https://example.com/page.html");
    expect(error).toBeInstanceOf(ImageFetchError);
    expect(String(error.cause)).toContain("text/html");
  });

  it("returns bytes and mime for an image response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      ),
    );
    const result = await Effect.runPromise(
      resolveImageBytes("https://example.com/a.png"),
    );
    expect(result.mime).toBe("image/png");
    expect([...result.bytes]).toEqual([1, 2, 3]);
  });
});
