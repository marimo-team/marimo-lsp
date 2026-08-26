import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import {
  makeTestNotebookRuntime,
  type TestCommand,
} from "../../__tests__/__utils__/TestMarimoClient.ts";
import type { NotebookController } from "../../kernel/NotebookRuntime.ts";
import { kernelSessionId } from "../../lib/__tests__/branded.ts";
import { FileSystemError, VsCode } from "../../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { KernelNotification } from "../../types.ts";
import {
  AUTO_EXPORT_INTERVAL,
  AutoExportLive,
  autoExportUri,
} from "../AutoExport.ts";

const controller: NotebookController = {
  id: "test-controller",
  drive: () => () => Effect.void,
  presentOutputs: () => Effect.void,
  resolveExecutable: () => Effect.succeed("/usr/bin/python"),
};
const SESSION_ID = kernelSessionId("00000000-0000-4000-8000-000000000001");

const withTestCtx = Effect.fn(function* (
  options: {
    readonly autoDownload?: ReadonlyArray<"html" | "ipynb" | "markdown">;
    readonly send?: (request: TestCommand) => Effect.Effect<string>;
    readonly hasOutputs?: boolean;
    readonly hasRuntimeSession?: boolean;
  } = {},
) {
  const calls = yield* Ref.make<ReadonlyArray<TestCommand>>([]);
  const writes = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const directories = yield* Ref.make<ReadonlyArray<string>>([]);
  const operations = yield* PubSub.unbounded<KernelNotification>();

  const output = {
    items: [
      {
        data: new TextEncoder().encode("2"),
        mime: "text/plain",
      },
    ],
  };
  const cellOutputs = options.hasOutputs === false ? [] : [output];
  const editor = TestVsCode.makeNotebookEditor("/test/report.py", {
    data: {
      metadata: MarimoNotebookDocument.createMetadata({
        appOptions: {
          managed: {
            autoDownload: [...(options.autoDownload ?? ["html", "ipynb"])],
          },
          passthrough: {},
        },
      }),
      cells: [
        {
          kind: 2,
          value: "1 + 1",
          languageId: "python",
          metadata: MarimoNotebookCell.createMetadata({
            marimoRuntime: { stableId: "cell-1" },
          }),
          outputs: cellOutputs,
        },
      ],
    },
  });
  const notebook = MarimoNotebookDocument.from(editor.notebook);

  const vscode = yield* TestVsCode.make({
    initialDocuments: [editor.notebook],
    workspace: {
      fs: {
        createDirectory: (uri) =>
          Ref.update(directories, (current) => [...current, uri.toString()]),
        readFile: (uri) =>
          Effect.fail(
            new FileSystemError({
              cause: new Error(`ENOENT: ${uri.toString()}`),
            }),
          ),
        writeFile: (uri, contents) =>
          Ref.update(writes, (current) => {
            const next = new Map(current);
            next.set(uri.toString(), new TextDecoder().decode(contents));
            return next;
          }),
      },
    },
  });

  const runtime = makeTestNotebookRuntime({
    initialControllers: [{ notebookUri: notebook.id, controller }],
    runtimeSession:
      options.hasRuntimeSession === false
        ? undefined
        : { executable: "/usr/bin/python", workingDirectory: "/test" },
    kernelNotifications: Stream.fromPubSub(operations),
    send: (request) =>
      Ref.update(calls, (current) => [...current, request]).pipe(
        Effect.andThen(
          options.send?.(request) ??
            Effect.succeed(
              request.kind === "export-html"
                ? "<html>report</html>"
                : request.kind === "export-markdown"
                  ? "# Report"
                  : "{}",
            ),
        ),
      ),
  });

  const layer = AutoExportLive.pipe(
    Layer.provide(runtime),
    Layer.provide(vscode.layer),
  );

  return {
    calls,
    cellOutputs,
    directories,
    editor,
    layer,
    notebook,
    operations,
    vscode,
    writes,
  };
});

describe("autoExportUri", () => {
  it.effect(
    "writes beside the notebook under __marimo__",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const uri = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return autoExportUri(code, ctx.notebook, "html");
      }).pipe(Effect.provide(ctx.vscode.layer));

      expect(uri.path).toBe("/test/__marimo__/report.html");
    }),
  );
});

describe("AutoExport", () => {
  it.effect(
    "exports Markdown to an md file",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx({ autoDownload: ["markdown"] });

      yield* Effect.gen(function* () {
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust(AUTO_EXPORT_INTERVAL);

        expect((yield* Ref.get(ctx.calls)).map((call) => call.kind)).toEqual([
          "export-markdown",
        ]);
        expect(Object.fromEntries(yield* Ref.get(ctx.writes))).toEqual({
          "file:///test/__marimo__/report.md": "# Report",
        });
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "waits for a live runtime session before creating exports",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx({ hasRuntimeSession: false });

      yield* Effect.gen(function* () {
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust(AUTO_EXPORT_INTERVAL);

        expect(yield* Ref.get(ctx.calls)).toEqual([]);
        expect(yield* Ref.get(ctx.directories)).toEqual([]);
        expect(yield* Ref.get(ctx.writes)).toEqual(new Map());
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "exports enabled formats once per live-session generation",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust(AUTO_EXPORT_INTERVAL);

        expect((yield* Ref.get(ctx.calls)).map((call) => call.kind)).toEqual([
          "export-html",
          "export-ipynb",
        ]);
        expect(Object.fromEntries(yield* Ref.get(ctx.writes))).toEqual({
          "file:///test/__marimo__/report.html": "<html>report</html>",
          "file:///test/__marimo__/report.ipynb": "{}",
        });
        expect(yield* Ref.get(ctx.directories)).toEqual([
          "file:///test/__marimo__",
        ]);

        yield* TestClock.adjust(AUTO_EXPORT_INTERVAL);
        expect(yield* Ref.get(ctx.calls)).toHaveLength(2);

        yield* PubSub.publish(ctx.operations, {
          notebookUri: ctx.notebook.id,
          sessionId: SESSION_ID,
          notification: { op: "completed-run", run_id: null },
        });
        yield* TestClock.adjust(AUTO_EXPORT_INTERVAL);
        expect((yield* Ref.get(ctx.calls)).map((call) => call.kind)).toEqual([
          "export-html",
          "export-ipynb",
          "export-html",
          "export-ipynb",
        ]);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "exports a notebook once when it has multiple visible editors",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust(AUTO_EXPORT_INTERVAL);

        expect((yield* Ref.get(ctx.calls)).map((call) => call.kind)).toEqual([
          "export-html",
          "export-ipynb",
        ]);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "waits for cell output before exporting HTML",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx({ hasOutputs: false });

      yield* Effect.gen(function* () {
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust(AUTO_EXPORT_INTERVAL);
        expect((yield* Ref.get(ctx.calls)).map((call) => call.kind)).toEqual([
          "export-ipynb",
        ]);

        ctx.cellOutputs.push({
          items: [
            {
              data: new TextEncoder().encode("2"),
              mime: "text/plain",
            },
          ],
        });
        yield* PubSub.publish(ctx.operations, {
          notebookUri: ctx.notebook.id,
          sessionId: SESSION_ID,
          notification: { op: "completed-run", run_id: null },
        });
        yield* TestClock.adjust(AUTO_EXPORT_INTERVAL);

        expect((yield* Ref.get(ctx.calls)).map((call) => call.kind)).toEqual([
          "export-ipynb",
          "export-html",
          "export-ipynb",
        ]);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "does not credit an in-flight export to a reopened notebook",
    Effect.fn(function* () {
      const exportStarted = yield* Deferred.make<void>();
      const releaseExport = yield* Deferred.make<void>();
      const ctx = yield* withTestCtx({
        send: (request) =>
          request.kind === "export-html"
            ? Deferred.succeed(exportStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseExport)),
                Effect.as("<html>old report</html>"),
              )
            : Effect.succeed("{}"),
      });

      yield* Effect.gen(function* () {
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        const firstTick = yield* Effect.forkChild(
          TestClock.adjust(AUTO_EXPORT_INTERVAL),
        );
        yield* Deferred.await(exportStarted);

        yield* ctx.vscode.closeNotebook(ctx.editor.notebook);
        yield* Effect.yieldNow;
        const reopened = TestVsCode.makeNotebookEditor("/test/report.py", {
          data: {
            metadata: MarimoNotebookDocument.createMetadata({
              appOptions: {
                managed: { autoDownload: ["html", "ipynb"] },
                passthrough: {},
              },
            }),
            cells: [
              {
                kind: 2,
                value: "2 + 2",
                languageId: "python",
                metadata: MarimoNotebookCell.createMetadata({
                  marimoRuntime: { stableId: "cell-1" },
                }),
                outputs: ctx.cellOutputs,
              },
            ],
          },
        });
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(reopened));
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseExport, undefined);
        yield* Fiber.join(firstTick);
        yield* TestClock.adjust(AUTO_EXPORT_INTERVAL);

        expect((yield* Ref.get(ctx.calls)).map((call) => call.kind)).toEqual([
          "export-html",
          "export-ipynb",
          "export-html",
          "export-ipynb",
        ]);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
