import { describe, expect, it } from "vitest";

import { uuidV5 } from "../LocalDiscoveryProtocol.ts";

describe("local discovery protocol", () => {
  it("generates RFC 9562 UUIDv5 identifiers", () => {
    expect(
      uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.widgets.com"),
    ).toMatchInlineSnapshot(`"21f7f8de-8051-5b89-8680-0195ef798b6a"`);
  });
});
