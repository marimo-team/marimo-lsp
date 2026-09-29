import * as Vitest from "@effect/vitest";
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

Vitest.describe("Models.gen (msgspec → Effect Schema codegen)", () => {
  Vitest.it("fills omitted fields with msgspec defaults on decode", () => {
    const decoded = Schema.decodeUnknownSync(CellMetadata)({});
    Vitest.expect(decoded).toMatchInlineSnapshot(`
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

  Vitest.it(
    "preserves open-envelope fields while rejecting unknown owned fields",
    () => {
      const decoded = Schema.decodeUnknownSync(CellMetadata)({
        foreign: { ownedBy: "another-extension" },
        marimo: { name: "cell" },
      });
      Vitest.expect(Schema.encodeSync(CellMetadata)(decoded)).toMatchObject({
        foreign: { ownedBy: "another-extension" },
        marimo: { name: "cell" },
      });

      Vitest.expect(
        Result.isFailure(
          Schema.decodeUnknownResult(CellMetadata)({
            marimo: { name: "cell", misspelled: true },
          }),
        ),
      ).toBe(true);
    },
  );

  Vitest.it("keeps the canonical notebook marimo namespace required", () => {
    Vitest.expect(
      Result.isFailure(
        Schema.decodeUnknownResult(NotebookDocumentMetadata)({}),
      ),
    ).toBe(true);
  });

  Vitest.it("decodes tagged unions by their msgspec tag field", () => {
    const venv = Schema.decodeUnknownSync(GetDependencyTree)({
      kind: "get-dependency-tree",
      notebookUri: "file:///nb.py",
      source: {
        kind: "venv",
        executable: "/usr/bin/python3",
      },
    }).source;
    Vitest.expect(venv).toEqual({
      kind: "venv",
      executable: "/usr/bin/python3",
    });

    const bad = Schema.decodeUnknownResult(GetDependencyTree)({
      kind: "get-dependency-tree",
      notebookUri: "file:///nb.py",
      source: { kind: "conda" },
    });
    Vitest.expect(Result.isFailure(bad)).toBe(true);

    // msgspec accepts an omitted tag when decoding a concrete struct, but
    // requires it when decoding the tagged union used by the command.
    const missing = Schema.decodeUnknownResult(GetDependencyTree)({
      kind: "get-dependency-tree",
      notebookUri: "file:///nb.py",
      source: {
        executable: "/usr/bin/python3",
      },
    });
    Vitest.expect(Result.isFailure(missing)).toBe(true);
  });

  Vitest.it("decodes the flat owned command protocol", () => {
    const decoded = Schema.decodeUnknownSync(Command)({
      kind: "execute",
      notebookUri: "file:///nb.py",
      executable: "/usr/bin/python3",
      workingDirectory: "/workspace",
      cells: [{ cellId: "cell-1", code: "answer = 42" }],
    });

    Vitest.expect(Schema.encodeSync(Command)(decoded)).toEqual({
      kind: "execute",
      notebookUri: "file:///nb.py",
      executable: "/usr/bin/python3",
      workingDirectory: "/workspace",
      cells: [{ cellId: "cell-1", code: "answer = 42" }],
    });

    Vitest.expect(
      Result.isFailure(
        Schema.decodeUnknownResult(Command)({
          kind: "execute-cells",
          notebookUri: "file:///nb.py",
        }),
      ),
    ).toBe(true);
  });

  Vitest.it("matches the shared command compatibility corpus", () => {
    for (const command of commandProtocol.valid) {
      const decoded = Schema.decodeUnknownSync(Command)(command);
      Vitest.expect(Schema.encodeSync(Command)(decoded)).toEqual(command);
    }

    for (const command of commandProtocol.invalid) {
      Vitest.expect(
        Result.isFailure(Schema.decodeUnknownResult(Command)(command)),
      ).toBe(true);
    }
  });

  Vitest.it("rejects payloads msgspec would reject", () => {
    const missingCode = Schema.decodeUnknownResult(ExecuteScratchpad)({
      kind: "execute-scratchpad",
      notebookUri: "file:///nb.py",
      runId: "abc",
    });
    Vitest.expect(Result.isFailure(missingCode)).toBe(true);
  });

  Vitest.it("decodes a generated package command", () => {
    const decoded = Schema.decodeUnknownSync(GetDependencyTree)({
      kind: "get-dependency-tree",
      notebookUri: "file:///nb.py",
      source: { kind: "script" },
    });
    Vitest.expect(decoded.source).toEqual({ kind: "script" });
  });

  Vitest.it("requires workingDirectory for execute commands", () => {
    Vitest.expect(() =>
      Schema.decodeUnknownSync(Execute)({
        kind: "execute",
        notebookUri: "file:///nb.py",
        executable: "/usr/bin/python",
        cells: [{ cellId: "cell-1", code: "print(1)" }],
      }),
    ).toThrow();
  });

  Vitest.it("names structs in parse errors via identifier annotations", () => {
    // The default formatter uses `identifier` as the expected label for a
    // type failure such as "Expected VenvSource". It does not use it for a
    // nested key issue.
    const result = Schema.decodeUnknownResult(VenvSource)("not-an-object");
    Vitest.expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      Vitest.expect(String(result.failure)).toContain("VenvSource");
    }
  });

  Vitest.it(
    "round-trips through encode to the wire shape msgspec expects",
    () => {
      const encoded = Schema.encodeSync(CellMetadata)({
        marimo: {
          name: "my_cell",
          options: { hide_code: true },
          sourceProjections: { markdown: null, sql: null },
        },
        marimoRuntime: { stableId: "abc", state: null },
      });
      Vitest.expect(encoded).toEqual({
        marimo: {
          name: "my_cell",
          options: { hide_code: true },
          sourceProjections: { markdown: null, sql: null },
        },
        marimoRuntime: { stableId: "abc", state: null },
      });
    },
  );

  Vitest.it("separates managed app options from the passthrough record", () => {
    const decoded = Schema.decodeUnknownSync(NotebookDocument)({
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
      appOptions: {
        managed: { autoDownload: ["html", "future-format"] },
        passthrough: { width: "full", future_setting: { answer: 42 } },
      },
      header: null,
    });

    Vitest.expect(Schema.encodeSync(NotebookDocument)(decoded).appOptions)
      .toMatchInlineSnapshot(`
        {
          "managed": {
            "autoDownload": [
              "html",
              "future-format",
            ],
          },
          "passthrough": {
            "future_setting": {
              "answer": 42,
            },
            "width": "full",
          },
        }
      `);
  });

  Vitest.it.effect("requires JSON null for fire-and-forget responses", () =>
    Effect.gen(function* () {
      const api = makeCommandClient(() => Effect.succeed(undefined));
      const result = yield* Effect.result(
        api.interrupt({ notebookUri: "file:///nb.py" }),
      );
      Vitest.expect(Result.isFailure(result)).toBe(true);
    }),
  );
});
