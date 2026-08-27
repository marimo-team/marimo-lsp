import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import commandProtocol from "../../../../tests/fixtures/command_protocol.json";
import {
  CellMetadata,
  Command,
  Execute,
  ExecuteScratchpad,
  GetDependencyTree,
  makeCommandClient,
  NotebookDocument,
  NotebookDocumentMetadata,
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
      Result.isFailure(
        Schema.decodeUnknownResult(CellMetadata)({
          marimo: { name: "cell", misspelled: true },
        }),
      ),
    ).toBe(true);
  });

  it("keeps the canonical notebook marimo namespace required", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(NotebookDocumentMetadata)({}),
      ),
    ).toBe(true);
  });

  it("decodes tagged unions by their msgspec tag field", () => {
    const venv = Schema.decodeUnknownSync(GetDependencyTree)({
      kind: "get-dependency-tree",
      notebookUri: "file:///nb.py",
      source: {
        kind: "venv",
        executable: "/usr/bin/python3",
      },
    }).source;
    expect(venv).toEqual({ kind: "venv", executable: "/usr/bin/python3" });

    const bad = Schema.decodeUnknownResult(GetDependencyTree)({
      kind: "get-dependency-tree",
      notebookUri: "file:///nb.py",
      source: { kind: "conda" },
    });
    expect(Result.isFailure(bad)).toBe(true);

    // msgspec accepts an omitted tag when decoding a concrete struct, but
    // requires it when decoding the tagged union used by the command.
    const missing = Schema.decodeUnknownResult(GetDependencyTree)({
      kind: "get-dependency-tree",
      notebookUri: "file:///nb.py",
      source: {
        executable: "/usr/bin/python3",
      },
    });
    expect(Result.isFailure(missing)).toBe(true);
  });

  it("decodes the flat owned command protocol", () => {
    const decoded = Schema.decodeUnknownSync(Command)({
      kind: "execute",
      notebookUri: "file:///nb.py",
      executable: "/usr/bin/python3",
      workingDirectory: "/workspace",
      cells: [{ cellId: "cell-1", code: "answer = 42" }],
    });

    expect(Schema.encodeSync(Command)(decoded)).toEqual({
      kind: "execute",
      notebookUri: "file:///nb.py",
      executable: "/usr/bin/python3",
      workingDirectory: "/workspace",
      cells: [{ cellId: "cell-1", code: "answer = 42" }],
    });

    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(Command)({
          kind: "execute-cells",
          notebookUri: "file:///nb.py",
        }),
      ),
    ).toBe(true);
  });

  it("matches the shared command compatibility corpus", () => {
    for (const command of commandProtocol.valid) {
      const decoded = Schema.decodeUnknownSync(Command)(command);
      expect(Schema.encodeSync(Command)(decoded)).toEqual(command);
    }

    for (const command of commandProtocol.invalid) {
      expect(
        Result.isFailure(Schema.decodeUnknownResult(Command)(command)),
      ).toBe(true);
    }
  });

  it("rejects payloads msgspec would reject", () => {
    const missingCode = Schema.decodeUnknownResult(ExecuteScratchpad)({
      kind: "execute-scratchpad",
      notebookUri: "file:///nb.py",
      runId: "abc",
    });
    expect(Result.isFailure(missingCode)).toBe(true);
  });

  it("decodes a generated package command", () => {
    const decoded = Schema.decodeUnknownSync(GetDependencyTree)({
      kind: "get-dependency-tree",
      notebookUri: "file:///nb.py",
      source: { kind: "script" },
    });
    expect(decoded.source).toEqual({ kind: "script" });
  });

  it("requires workingDirectory for execute commands", () => {
    expect(() =>
      Schema.decodeUnknownSync(Execute)({
        kind: "execute",
        notebookUri: "file:///nb.py",
        executable: "/usr/bin/python",
        cells: [{ cellId: "cell-1", code: "print(1)" }],
      }),
    ).toThrow();
  });

  it("names structs in parse errors via identifier annotations", () => {
    // The default formatter uses `identifier` as the expected label for a
    // type failure such as "Expected VenvSource". It does not use it for a
    // nested key issue.
    const result = Schema.decodeUnknownResult(VenvSource)("not-an-object");
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(String(result.failure)).toContain("VenvSource");
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

  it("preserves app constructor options as an open record", () => {
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
      appConfig: { width: "full", future_setting: { answer: 42 } },
      header: null,
    });

    expect(decoded.notebook.cells[0]?.config.hide_code).toBe(true);
    expect(decoded.appConfig?.width).toBe("full");
    expect(decoded.appConfig?.future_setting).toEqual({ answer: 42 });
    expect(
      Schema.encodeSync(NotebookDocument)(decoded).appConfig?.future_setting,
    ).toEqual({ answer: 42 });
  });

  it.effect("requires JSON null for fire-and-forget responses", () =>
    Effect.gen(function* () {
      const api = makeCommandClient(() => Effect.succeed(undefined));
      const result = yield* Effect.result(
        api.interrupt({ notebookUri: "file:///nb.py" }),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );
});
