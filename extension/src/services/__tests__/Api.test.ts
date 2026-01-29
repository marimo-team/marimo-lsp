import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, PubSub, Queue, Stream, TestClock } from "effect";
import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestSentryLive } from "../../__mocks__/TestSentry.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { NOTEBOOK_TYPE, SCRATCH_CELL_ID } from "../../constants.ts";
import type { NotebookId } from "../../schemas.ts";
import type { MarimoCommand, Notification } from "../../types.ts";
import { Api } from "../Api.ts";
import { ControllerRegistry } from "../ControllerRegistry.ts";
import { LanguageClient } from "../LanguageClient.ts";
import { VsCode } from "../VsCode.ts";

interface MarimoOperation {
  notebookUri: NotebookId;
  operation: Notification;
}

/**
 * Creates a controllable mock LanguageClient for testing.
 *
 * Returns:
 * - layer: The Layer to provide to tests
 * - emit: Function to emit marimo/operation notifications
 * - lastCommand: Ref to the last executeCommand call
 */
function createMockLanguageClient() {
  return Effect.gen(function* () {
    const operationsPubSub = yield* PubSub.unbounded<MarimoOperation>();
    const commandsQueue = yield* Queue.unbounded<MarimoCommand>();
    return {
      layer: Layer.succeed(
        LanguageClient,
        LanguageClient.make({
          channel: { name: "marimo-lsp-test", show() {} },
          restart: Effect.void,
          executeCommand(cmd) {
            return Queue.offer(commandsQueue, cmd);
          },
          streamOf(notification) {
            if (notification === "marimo/operation") {
              return Stream.fromPubSub(operationsPubSub) as never;
            }
            return Stream.never;
          },
        }),
      ),
      /** Emit a marimo/operation notification */
      emit: (op: MarimoOperation) => PubSub.publish(operationsPubSub, op),
      /** Get the next command that was sent */
      takeCommand: () => Queue.take(commandsQueue),
      /** Check if a command was sent (non-blocking) */
      pollCommand: () => Queue.poll(commandsQueue),
    };
  });
}

const withTestCtx = Effect.fnUntraced(function* (
  options: Parameters<(typeof TestVsCode)["make"]>[0] = {},
) {
  const testVsCode = yield* TestVsCode.make(options);
  const mockLsp = yield* createMockLanguageClient();
  return {
    vscode: testVsCode,
    lsp: mockLsp,
    layer: Layer.empty.pipe(
      Layer.merge(Api.Default),
      Layer.provideMerge(ControllerRegistry.Default),
      Layer.provide(mockLsp.layer),
      Layer.provide(TestTelemetryLive),
      Layer.provide(TestSentryLive),
      Layer.provide(TestPythonExtension.Default),
      Layer.provideMerge(testVsCode.layer),
    ),
  };
});

describe("Api", () => {
  it.scoped(
    "has experimental.kernels namespace",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();

      const api = yield* Api.pipe(Effect.provide(ctx.layer));

      expect(api).toBeDefined();
      expect(api.experimental).toBeDefined();
      expect(api.experimental.kernels).toBeDefined();
      expect(typeof api.experimental.kernels.getKernel).toBe("function");
    }),
  );

  it.scoped(
    "getKernel returns undefined for non-existent notebook",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();

      const kernel = yield* Effect.gen(function* () {
        const api = yield* Api;
        const code = yield* VsCode;
        const fakeUri = yield* code.utils.parseUri(
          "file:///non-existent-notebook.py",
        );

        return yield* Effect.promise(() =>
          api.experimental.kernels.getKernel(fakeUri),
        );
      }).pipe(Effect.provide(ctx.layer));

      expect(kernel).toBeUndefined();
    }),
  );

  it.scoped(
    "getKernel returns undefined when notebook exists but no controller",
    Effect.fnUntraced(function* () {
      const notebookDoc = createTestNotebookDocument(
        "file:///test/notebook_mo.py",
        {
          data: {
            cells: [
              {
                kind: 1,
                value: "x = 42",
                languageId: "python",
                metadata: { stableId: "cell-1" },
              },
            ],
          },
        },
      );

      const ctx = yield* withTestCtx({ initialDocuments: [notebookDoc] });

      const kernel = yield* Effect.gen(function* () {
        const api = yield* Api;
        const code = yield* VsCode;
        const uri = yield* code.utils.parseUri("file:///test/notebook_mo.py");
        return yield* Effect.promise(() =>
          api.experimental.kernels.getKernel(uri),
        );
      }).pipe(Effect.provide(ctx.layer));

      expect(kernel).toBeUndefined();
    }),
  );

  it.scoped(
    "getKernel returns kernel when notebook has active controller",
    Effect.fnUntraced(function* () {
      const notebookDoc = createTestNotebookDocument(
        "file:///test/notebook_mo.py",
        {
          data: {
            cells: [
              {
                kind: 1,
                value: "x = 42",
                languageId: "python",
                metadata: { stableId: "cell-1" },
              },
            ],
          },
        },
      );

      const ctx = yield* withTestCtx({ initialDocuments: [notebookDoc] });

      const kernel = yield* Effect.gen(function* () {
        const api = yield* Api;
        const code = yield* VsCode;
        const controllers = yield* ControllerRegistry;

        // Create and register a controller
        const controller = yield* code.notebooks.createNotebookController(
          "test-controller",
          NOTEBOOK_TYPE,
          "Test Controller",
        );

        yield* controllers.registerController(
          "file:///test/notebook_mo.py",
          controller,
        );

        const uri = yield* code.utils.parseUri("file:///test/notebook_mo.py");

        return yield* Effect.promise(() =>
          api.experimental.kernels.getKernel(uri),
        );
      }).pipe(Effect.provide(ctx.layer));

      expect(kernel).toBeDefined();
      expect(kernel?.status).toBe("idle");
      expect(kernel?.language).toBe("python");
      expect(typeof kernel?.executeCode).toBe("function");
    }),
  );

  it.scoped(
    "kernel.executeCode sends command and returns outputs from stream",
    Effect.fnUntraced(function* () {
      const NOTEBOOK_URI = "file:///test/notebook_mo.py";

      const notebookDoc = createTestNotebookDocument(NOTEBOOK_URI, {
        data: {
          cells: [
            {
              kind: 1,
              value: "x = 42",
              languageId: "python",
              metadata: { stableId: "cell-1" },
            },
          ],
        },
      });

      const ctx = yield* withTestCtx({ initialDocuments: [notebookDoc] });

      yield* Effect.gen(function* () {
        const api = yield* Api;
        const code = yield* VsCode;
        const controllers = yield* ControllerRegistry;

        // Register controller
        const controller = yield* code.notebooks.createNotebookController(
          "test-controller",
          NOTEBOOK_TYPE,
          "Test Controller",
        );

        yield* controllers.registerController(NOTEBOOK_URI, controller);

        const uri = yield* code.utils.parseUri(NOTEBOOK_URI);
        const kernel = yield* Effect.promise(() =>
          api.experimental.kernels.getKernel(uri),
        );
        assert(kernel, "Expected kernel for notebook.");

        // Start collecting outputs in background
        const outputsPromise = Array.fromAsync(
          kernel.executeCode("print('hi')"),
        );

        // Wait a tick for the command to be sent
        yield* TestClock.adjust("10 millis");

        // Verify the command was sent with correct code
        const cmd = yield* ctx.lsp.takeCommand();
        expect(cmd.command).toBe("marimo.api");
        expect(cmd.params).toMatchObject({
          method: "execute-scratchpad",
          params: {
            notebookUri: NOTEBOOK_URI,
            inner: { code: "print('hi')" },
          },
        });

        // Emit mock cell operations through the stream
        yield* ctx.lsp.emit({
          notebookUri: NOTEBOOK_URI as NotebookId,
          operation: {
            op: "cell-op",
            cell_id: SCRATCH_CELL_ID,
            status: "running",
            console: [],
            timestamp: Date.now(),
          },
        });

        yield* ctx.lsp.emit({
          notebookUri: NOTEBOOK_URI as NotebookId,
          operation: {
            op: "cell-op",
            cell_id: SCRATCH_CELL_ID,
            console: {
              channel: "stdout",
              mimetype: "text/plain",
              data: "hi\n",
              timestamp: Date.now(),
            },
            timestamp: Date.now(),
          },
        });

        yield* ctx.lsp.emit({
          notebookUri: NOTEBOOK_URI as NotebookId,
          operation: {
            op: "cell-op",
            cell_id: SCRATCH_CELL_ID,
            status: "idle",
            timestamp: Date.now(),
          },
        });

        // Wait for the trailing 50ms after idle
        yield* TestClock.adjust("100 millis");

        const outputs = yield* Effect.promise(() => outputsPromise);

        // Should have stdout output
        expect(outputs.length).toBeGreaterThan(0);

        // Find stdout output
        const stdoutOutput = outputs.find((output) =>
          output.items.some(
            (item) => item.mime === "application/vnd.code.notebook.stdout",
          ),
        );
        expect(stdoutOutput).toBeDefined();

        if (stdoutOutput) {
          const stdoutItem = stdoutOutput.items.find(
            (item) => item.mime === "application/vnd.code.notebook.stdout",
          );
          if (stdoutItem) {
            const decoder = new TextDecoder();
            expect(decoder.decode(stdoutItem.data)).toBe("hi\n");
          }
        }
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
