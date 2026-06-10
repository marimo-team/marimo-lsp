import { describe, expect, it } from "vitest";

import { decodeDataUri } from "../imageResolver.ts";

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
});
