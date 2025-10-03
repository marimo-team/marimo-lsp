import { describe, expect, it } from "vitest";
import { createMockContext } from "../__mocks__/context.ts";
import { activate } from "../extension.ts";

describe("extension", () => {
  it("activation returns expected interface", async () => {
    const result = await activate(createMockContext());
    expect(result).toMatchInlineSnapshot(`
      {
        "dispose": [Function],
      }
    `);
  });
});
