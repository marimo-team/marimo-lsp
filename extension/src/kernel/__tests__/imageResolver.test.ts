import * as Vitest from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import {
  decodeDataUri,
  ImageFetchError,
  resolveImageBytes,
} from "../imageResolver.ts";

const fetchLayer = (fetch: typeof globalThis.fetch) =>
  FetchHttpClient.layer.pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );

const unexpectedFetch = Vitest.vi.fn<typeof globalThis.fetch>(() =>
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

Vitest.describe("decodeDataUri", () => {
  Vitest.it("decodes a base64 data URI", () => {
    // "hi" base64-encoded
    const result = decodeDataUri("data:image/png;base64,aGk=");
    Vitest.expect(result).not.toBeNull();
    Vitest.expect(result?.mime).toBe("image/png");
    Vitest.expect(new TextDecoder().decode(result?.bytes)).toBe("hi");
  });

  Vitest.it("decodes a non-base64 (url-encoded) data URI", () => {
    const result = decodeDataUri("data:image/svg+xml,%3Csvg%2F%3E");
    Vitest.expect(result?.mime).toBe("image/svg+xml");
    Vitest.expect(new TextDecoder().decode(result?.bytes)).toBe("<svg/>");
  });

  Vitest.it("returns null for a non-data URL", () => {
    Vitest.expect(decodeDataUri("https://example.com/a.svg")).toBeNull();
  });

  Vitest.it("returns null for malformed percent-encoding", () => {
    Vitest.expect(decodeDataUri("data:image/svg+xml,%")).toBeNull();
  });
});

Vitest.describe("resolveImageBytes", () => {
  // Effect.flip moves the error onto the success channel so we can assert on it;
  // if the effect unexpectedly succeeds, flip fails the run and the test fails.
  const expectError = (src: string) => Effect.flip(resolveImageBytes(src));

  unsupportedUrlIt.effect(
    "rejects unsupported URL schemes before fetching",
    Effect.fn(function* () {
      const error = yield* expectError("file:///etc/passwd");
      Vitest.expect(error).toBeInstanceOf(ImageFetchError);
      Vitest.expect(String(error.cause)).toContain("unsupported URL scheme");
      Vitest.expect(unexpectedFetch).not.toHaveBeenCalled();
    }),
  );

  notFoundIt.effect(
    "rejects non-OK responses without reading the body",
    Effect.fn(function* () {
      const error = yield* expectError("https://example.com/missing.png");
      Vitest.expect(error).toBeInstanceOf(ImageFetchError);
      Vitest.expect(String(error.cause)).toContain("404");
    }),
  );

  htmlIt.effect(
    "rejects non-image content types",
    Effect.fn(function* () {
      const error = yield* expectError("https://example.com/page.html");
      Vitest.expect(error).toBeInstanceOf(ImageFetchError);
      Vitest.expect(String(error.cause)).toContain("text/html");
    }),
  );

  imageIt.effect(
    "returns bytes and mime for an image response",
    Effect.fn(function* () {
      const result = yield* resolveImageBytes("https://example.com/a.png");
      Vitest.expect(result.mime).toBe("image/png");
      Vitest.expect([...result.bytes]).toEqual([1, 2, 3]);
    }),
  );
});
