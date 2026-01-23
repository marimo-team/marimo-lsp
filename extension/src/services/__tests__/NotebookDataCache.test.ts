import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, TestClock } from "effect";
import {
  createTestNotebookDocument,
  TestVsCode,
  Uri,
} from "../../__mocks__/TestVsCode.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { NotebookDataCache } from "../NotebookDataCache.ts";

function makeCacheLayer(vscode: TestVsCode) {
  return Layer.empty.pipe(
    Layer.provideMerge(NotebookDataCache.Default),
    Layer.provideMerge(vscode.layer),
  );
}

it.effect(
  "should gracefully handle file read errors when matching notebooks from bytes",
  Effect.fnUntraced(function* () {
    const deletedFileUri = Uri.file("/test/deleted_mo.py");
    const notebookContent = "x = 1";

    // Configure file system: the file returns an error (simulating deletion)
    const fileSystem = new Map<string, Uint8Array | Error>([
      [deletedFileUri.toString(), new Error("ENOENT: file deleted")],
    ]);

    // Create a notebook document for the "deleted" file
    const deletedNotebook = createTestNotebookDocument(deletedFileUri, {
      notebookType: NOTEBOOK_TYPE,
      data: {
        cells: [
          {
            kind: 2,
            value: notebookContent,
            languageId: "python",
            metadata: { stableId: "test-stable-id" },
          },
        ],
      },
    });

    const vscode = yield* TestVsCode.make({ fileSystem });

    yield* Effect.provide(
      Effect.gen(function* () {
        const cache = yield* NotebookDataCache;

        // Simulate the notebook being opened - this adds it to the MRU list
        yield* vscode.openNotebook(deletedNotebook);
        yield* TestClock.adjust("10 millis");

        // Now call cache.get() with some bytes
        // The cache will iterate through the MRU list (which contains deletedNotebook)
        // and try to read the file. Since the file is "deleted" (returns error),
        // it should gracefully continue instead of throwing.
        const bytes = new TextEncoder().encode(notebookContent);
        const result = yield* cache.get(bytes);

        // Should return None without throwing an error
        expect(Option.isNone(result)).toBe(true);
      }),
      makeCacheLayer(vscode),
    );
  }),
);

it.effect(
  "should skip deleted files and continue checking other notebooks in MRU list",
  Effect.fnUntraced(function* () {
    const deletedFileUri = Uri.file("/test/deleted_mo.py");
    const existingFileUri = Uri.file("/test/existing_mo.py");
    const notebookContent = "print('hello')";
    const encodedContent = new TextEncoder().encode(notebookContent);

    // Configure file system: one file deleted, one exists with matching content
    const fileSystem = new Map<string, Uint8Array | Error>([
      [deletedFileUri.toString(), new Error("ENOENT: file deleted")],
      [existingFileUri.toString(), encodedContent],
    ]);

    const deletedNotebook = createTestNotebookDocument(deletedFileUri, {
      notebookType: NOTEBOOK_TYPE,
      data: {
        cells: [
          {
            kind: 2,
            value: "different content",
            languageId: "python",
            metadata: { stableId: "deleted-id" },
          },
        ],
      },
    });

    const existingNotebook = createTestNotebookDocument(existingFileUri, {
      notebookType: NOTEBOOK_TYPE,
      data: {
        cells: [
          {
            kind: 2,
            value: notebookContent,
            languageId: "python",
            metadata: { stableId: "existing-id" },
          },
        ],
      },
    });

    const vscode = yield* TestVsCode.make({ fileSystem });

    yield* Effect.provide(
      Effect.gen(function* () {
        const cache = yield* NotebookDataCache;

        // Open both notebooks - adds them to MRU list
        // The deleted one is opened first, so it will be checked first
        yield* vscode.openNotebook(deletedNotebook);
        yield* TestClock.adjust("10 millis");
        yield* vscode.openNotebook(existingNotebook);
        yield* TestClock.adjust("10 millis");

        // Call cache.get() with content matching the existing notebook
        // It should skip the deleted file (which errors) and find the existing one
        const result = yield* cache.get(encodedContent);

        // Should return None since we haven't called cache.set() yet
        // But critically, it should NOT throw due to the deleted file
        expect(Option.isNone(result)).toBe(true);
      }),
      makeCacheLayer(vscode),
    );
  }),
);

it.effect(
  "should return None when file exists but content does not match",
  Effect.fnUntraced(function* () {
    const existingFileUri = Uri.file("/test/existing_mo.py");
    const fileContent = "x = 1";
    const differentContent = "y = 2";

    // File exists with different content than what we're looking for
    const fileSystem = new Map<string, Uint8Array | Error>([
      [existingFileUri.toString(), new TextEncoder().encode(fileContent)],
    ]);

    const existingNotebook = createTestNotebookDocument(existingFileUri, {
      notebookType: NOTEBOOK_TYPE,
      data: {
        cells: [
          {
            kind: 2,
            value: fileContent,
            languageId: "python",
            metadata: { stableId: "test-id" },
          },
        ],
      },
    });

    const vscode = yield* TestVsCode.make({ fileSystem });

    yield* Effect.provide(
      Effect.gen(function* () {
        const cache = yield* NotebookDataCache;

        // Open the notebook
        yield* vscode.openNotebook(existingNotebook);
        yield* TestClock.adjust("10 millis");

        // Try to get cache for different content - should not match
        const bytes = new TextEncoder().encode(differentContent);
        const result = yield* cache.get(bytes);

        // Should return None since content doesn't match
        expect(Option.isNone(result)).toBe(true);
      }),
      makeCacheLayer(vscode),
    );
  }),
);
