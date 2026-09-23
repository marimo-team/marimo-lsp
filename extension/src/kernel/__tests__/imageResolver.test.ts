import { describe, expect, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import {
  decodeDataUri,
  ImageFetchError,
  resolveImageBytes,
} from "../imageResolver.ts";

const fetchLayer = (fetch: typeof globalThis.fetch) =>
  FetchHttpClient.layer.pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );

const unexpectedFetch = vi.fn<typeof globalThis.fetch>(() =>
  Promise.reject(new Error("Unexpected HTTP request")),
);
const unsupportedUrlIt = EffectTest.make(fetchLayer(unexpectedFetch));
const notFoundIt = EffectTest.make(
  fetchLayer(
    async () =>
      new Response("not found", {
        status: 404,
        statusText: "Not Found",
      }),
  ),
);
const htmlIt = EffectTest.make(
  fetchLayer(
    async () =>
      new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  ),
);
const imageIt = EffectTest.make(
  fetchLayer(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  ),
);

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
  // Effect.flip moves the error onto the success channel so we can assert on it;
  // if the effect unexpectedly succeeds, flip fails the run and the test fails.
  const expectError = (src: string) => Effect.flip(resolveImageBytes(src));

  unsupportedUrlIt.effect(
    "rejects unsupported URL schemes before fetching",
    Effect.fn(function* () {
      const error = yield* expectError("file:///etc/passwd");
      expect(error).toBeInstanceOf(ImageFetchError);
      expect(String(error.cause)).toContain("unsupported URL scheme");
      expect(unexpectedFetch).not.toHaveBeenCalled();
    }),
  );

  notFoundIt.effect(
    "rejects non-OK responses without reading the body",
    Effect.fn(function* () {
      const error = yield* expectError("https://example.com/missing.png");
      expect(error).toBeInstanceOf(ImageFetchError);
      expect(String(error.cause)).toContain("404");
    }),
  );

  htmlIt.effect(
    "rejects non-image content types",
    Effect.fn(function* () {
      const error = yield* expectError("https://example.com/page.html");
      expect(error).toBeInstanceOf(ImageFetchError);
      expect(String(error.cause)).toContain("text/html");
    }),
  );

  imageIt.effect(
    "returns bytes and mime for an image response",
    Effect.fn(function* () {
      const result = yield* resolveImageBytes("https://example.com/a.png");
      expect(result.mime).toBe("image/png");
      expect([...result.bytes]).toEqual([1, 2, 3]);
    }),
  );
});
