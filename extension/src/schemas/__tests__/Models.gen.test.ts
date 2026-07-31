import { describe, expect, it } from "@effect/vitest";
import { Either, Schema } from "effect";

import {
  CellMetadata,
  ExecuteScratchRequest,
  PackageCommand,
  PackageSource,
  VenvSource,
} from "../Models.gen.ts";

describe("Models.gen (msgspec → Effect Schema codegen)", () => {
  it("fills omitted fields with msgspec defaults on decode", () => {
    const decoded = Schema.decodeUnknownSync(CellMetadata)({});
    expect(decoded).toMatchInlineSnapshot(`
      {
        "languageMetadata": null,
        "name": "_",
        "options": {},
        "stableId": null,
      }
    `);
  });

  it("decodes tagged unions by their msgspec tag field", () => {
    const venv = Schema.decodeUnknownSync(PackageSource)({
      kind: "venv",
      executable: "/usr/bin/python3",
    });
    expect(venv).toEqual({ kind: "venv", executable: "/usr/bin/python3" });

    const bad = Schema.decodeUnknownEither(PackageSource)({ kind: "conda" });
    expect(Either.isLeft(bad)).toBe(true);
  });

  it("rejects payloads msgspec would reject", () => {
    const missingCode = Schema.decodeUnknownEither(ExecuteScratchRequest)({
      runId: "abc",
    });
    expect(Either.isLeft(missingCode)).toBe(true);
  });

  it("composes generic command wrappers around an inner schema", () => {
    const command = PackageCommand(Schema.Struct({ query: Schema.String }));
    const decoded = Schema.decodeUnknownSync(command)({
      notebookUri: "file:///nb.py",
      source: { kind: "script" },
      inner: { query: "polars" },
    });
    expect(decoded.inner.query).toBe("polars");
    expect(decoded.source).toEqual({ kind: "script" });
  });

  it("names structs in parse errors via identifier annotations", () => {
    const result = Schema.decodeUnknownEither(VenvSource)({ kind: "venv" });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(String(result.left)).toContain("VenvSource");
    }
  });

  it("round-trips through encode to the wire shape msgspec expects", () => {
    const encoded = Schema.encodeSync(CellMetadata)({
      stableId: "abc",
      name: "my_cell",
      options: { hide_code: true },
      languageMetadata: null,
    });
    expect(encoded).toMatchInlineSnapshot(`
      {
        "languageMetadata": null,
        "name": "my_cell",
        "options": {
          "hide_code": true,
        },
        "stableId": "abc",
      }
    `);
  });
});
