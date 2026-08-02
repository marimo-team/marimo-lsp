import { describe, expect, it } from "@effect/vitest";
import { Effect, Either, Schema } from "effect";

import {
  CellMetadata,
  ExecuteScratchRequest,
  makeApiClient,
  NotebookDocument,
  NotebookDocumentMetadata,
  PackageCommand,
  PackageSource,
  SessionCommand,
  VenvSource,
} from "../Models.gen.ts";

describe("Models.gen (msgspec → Effect Schema codegen)", () => {
  it("fills omitted fields with msgspec defaults on decode", () => {
    const decoded = Schema.decodeUnknownSync(CellMetadata)({});
    expect(decoded).toMatchInlineSnapshot(`
      {
        "marimo": {
          "name": "_",
          "options": {},
          "sourceProjections": {
            "markdown": null,
            "sql": null,
          },
        },
        "marimoRuntime": {
          "stableId": null,
          "state": null,
        },
      }
    `);
  });

  it("preserves open-envelope fields while rejecting unknown owned fields", () => {
    const decoded = Schema.decodeUnknownSync(CellMetadata)({
      foreign: { ownedBy: "another-extension" },
      marimo: { name: "cell" },
    });
    expect(Schema.encodeSync(CellMetadata)(decoded)).toMatchObject({
      foreign: { ownedBy: "another-extension" },
      marimo: { name: "cell" },
    });

    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(CellMetadata)({
          marimo: { name: "cell", misspelled: true },
        }),
      ),
    ).toBe(true);
  });

  it("keeps the canonical notebook marimo namespace required", () => {
    expect(
      Either.isLeft(Schema.decodeUnknownEither(NotebookDocumentMetadata)({})),
    ).toBe(true);
  });

  it("decodes tagged unions by their msgspec tag field", () => {
    const venv = Schema.decodeUnknownSync(PackageSource)({
      kind: "venv",
      executable: "/usr/bin/python3",
    });
    expect(venv).toEqual({ kind: "venv", executable: "/usr/bin/python3" });

    const bad = Schema.decodeUnknownEither(PackageSource)({ kind: "conda" });
    expect(Either.isLeft(bad)).toBe(true);

    // msgspec accepts an omitted tag when decoding a concrete struct, but
    // requires it when decoding the tagged union used at this wire boundary.
    const missing = Schema.decodeUnknownEither(PackageSource)({
      executable: "/usr/bin/python3",
    });
    expect(Either.isLeft(missing)).toBe(true);
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

  it("requires workingDirectory for session commands", () => {
    const command = SessionCommand(Schema.Struct({ code: Schema.String }));
    expect(() =>
      Schema.decodeUnknownSync(command)({
        notebookUri: "file:///nb.py",
        executable: "/usr/bin/python",
        inner: { code: "print(1)" },
      }),
    ).toThrow();
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
      marimo: {
        name: "my_cell",
        options: { hide_code: true },
        sourceProjections: { markdown: null, sql: null },
      },
      marimoRuntime: { stableId: "abc", state: null },
    });
    expect(encoded).toEqual({
      marimo: {
        name: "my_cell",
        options: { hide_code: true },
        sourceProjections: { markdown: null, sql: null },
      },
      marimoRuntime: { stableId: "abc", state: null },
    });
  });

  it("models the notebook wire document without an opaque record", () => {
    const decoded = Schema.decodeUnknownSync(NotebookDocument)({
      notebook: {
        version: "1",
        metadata: { marimo_version: "0.23.15" },
        cells: [
          {
            id: "cell-id",
            code: "x = 1",
            code_hash: null,
            name: "cell",
            config: { hide_code: true },
          },
        ],
      },
      appConfig: { width: "full" },
      header: null,
    });

    expect(decoded.notebook.cells[0]?.config.hide_code).toBe(true);
    expect(decoded.appConfig?.width).toBe("full");
  });

  it.effect("requires JSON null for fire-and-forget responses", () =>
    Effect.gen(function* () {
      const api = makeApiClient(() => Effect.succeed(undefined));
      const result = yield* Effect.either(
        api.interrupt({ notebookUri: "file:///nb.py", inner: {} }),
      );
      expect(Either.isLeft(result)).toBe(true);
    }),
  );
});
