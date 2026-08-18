import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Ref, Stream } from "effect";
import { vi } from "vite-plus/test";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { MarimoLspServer } from "../../config/Config.ts";
import { kernelSessionId, notebookId } from "../../lib/__tests__/branded.ts";
import type {
  DocumentAnalysis,
  KernelNotification,
  MarimoApiCall,
} from "../../types.ts";
import {
  disposeLanguageClient,
  findMarimoLspExecutable,
  findWasmMarimoLspExecutable,
  makeMarimoCommands,
  makeCustomLspFailureNotifier,
  makeDocumentAnalysisStream,
  makeKernelNotificationStream,
  selectMarimoLspExecutable,
} from "../MarimoClient.ts";

const notebook = notebookId("notebook-a");

describe("custom language-server failures", () => {
  it.effect(
    "prompts once and opens the selected recovery surface",
    Effect.fn(function* () {
      const prompts = yield* Ref.make(0);
      let logsOpened = 0;
      const vscode = yield* TestVsCode.make({
        window: {
          showErrorMessage: (message, options = {}) => {
            expect(message).toContain(
              "Custom language servers are for extension development",
            );
            return Ref.update(prompts, (count) => count + 1).pipe(
              Effect.as(
                Option.fromNullishOr(
                  options.items?.find((item) => item === "Open Settings"),
                ),
              ),
            );
          },
        },
      });
      const notify = yield* makeCustomLspFailureNotifier({
        mode: "configured",
        channel: {
          name: "marimo-lsp",
          show: () => {
            logsOpened += 1;
          },
        },
      }).pipe(Effect.provide(vscode.layer));

      yield* Effect.all([notify, notify], { concurrency: "unbounded" });

      expect(yield* Ref.get(prompts)).toBe(1);
      expect(logsOpened).toBe(0);
      expect(yield* Ref.get(vscode.executions)).toContainEqual({
        command: "workbench.action.openSettings",
        args: ["marimo.lsp"],
      });
    }),
  );

  it.effect(
    "opens logs when selected",
    Effect.fn(function* () {
      let logsOpened = 0;
      const vscode = yield* TestVsCode.make({
        window: {
          showErrorMessage: (_message, options = {}) =>
            Effect.succeed(
              Option.fromNullishOr(
                options.items?.find((item) => item === "Open Logs"),
              ),
            ),
        },
      });
      const notify = yield* makeCustomLspFailureNotifier({
        mode: "configured",
        channel: {
          name: "marimo-lsp",
          show: () => {
            logsOpened += 1;
          },
        },
      }).pipe(Effect.provide(vscode.layer));

      yield* notify;

      expect(logsOpened).toBe(1);
      expect(yield* Ref.get(vscode.executions)).toEqual([]);
    }),
  );

  it.effect(
    "does not prompt for bundled language servers",
    Effect.fn(function* () {
      const prompts = yield* Ref.make(0);
      const vscode = yield* TestVsCode.make({
        window: {
          showErrorMessage: () =>
            Ref.update(prompts, (count) => count + 1).pipe(
              Effect.as(Option.none()),
            ),
        },
      });
      for (const mode of ["wasm", "uv"] as const) {
        const notify = yield* makeCustomLspFailureNotifier({
          mode,
          channel: { name: "marimo-lsp", show() {} },
        }).pipe(Effect.provide(vscode.layer));
        yield* notify;
      }

      expect(yield* Ref.get(prompts)).toBe(0);
    }),
  );
});

it.effect(
  "does not fail scope cleanup when language-client disposal rejects",
  Effect.fn(function* () {
    const dispose = vi.fn(() =>
      Promise.reject(new Error("client is startFailed")),
    );

    yield* disposeLanguageClient({ dispose });

    expect(dispose).toHaveBeenCalledOnce();
  }),
);

it.effect(
  "constructs marimo.api commands through named methods",
  Effect.fn(function* () {
    const calls = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
    const responses: Record<string, unknown> = {
      "execute-cells": null,
      "set-display-theme": { success: true },
    };
    const marimo = makeMarimoCommands({
      execute: (request) =>
        Ref.update(calls, (current) => [...current, request]).pipe(
          Effect.as(responses[request.method]),
        ),
      kernelNotifications: Stream.empty,
    });

    yield* marimo.executeCells({
      notebookUri: notebook,
      executable: "/python",
      workingDirectory: "/workspace",
      inner: { cellIds: [], codes: [] },
    });
    yield* marimo.setDisplayTheme({ theme: "dark" });

    assert.deepStrictEqual(yield* Ref.get(calls), [
      {
        method: "execute-cells",
        params: {
          notebookUri: notebook,
          executable: "/python",
          workingDirectory: "/workspace",
          inner: { cellIds: [], codes: [] },
        },
      },
      {
        method: "set-display-theme",
        params: { theme: "dark" },
      },
    ]);
  }),
);

describe("generated api client", () => {
  it.effect(
    "parses responses against the method's success schema",
    Effect.fn(function* () {
      const marimo = makeMarimoCommands({
        execute: () =>
          Effect.succeed({
            tree: { name: "root", version: null, tags: [], dependencies: [] },
          }),
        kernelNotifications: Stream.empty,
      });

      const response = yield* marimo.getDependencyTree({
        notebookUri: notebook,
        source: { kind: "script" },
        inner: {},
      });

      // Response is parsed, not asserted: `tree` is a typed DependencyTreeNode.
      assert.strictEqual(response.tree?.name, "root");
    }),
  );

  it.effect(
    "fails with ParseError when the server response violates the contract",
    Effect.fn(function* () {
      const marimo = makeMarimoCommands({
        execute: () => Effect.succeed({ tree: "not-a-tree" }),
        kernelNotifications: Stream.empty,
      });

      const exit = yield* marimo
        .getDependencyTree({
          notebookUri: notebook,
          source: { kind: "script" },
          inner: {},
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      // The formatter names the schema and the path of the field that
      // failed. It does not name the response type that contains it.
      assert.include(String(exit), "SchemaError");
      assert.include(String(exit), "DependencyTreeNode");
      assert.include(String(exit), '["tree"]');
    }),
  );

  it.effect(
    "rejects params the server would reject, before hitting the wire",
    Effect.fn(function* () {
      const marimo = makeMarimoCommands({
        execute: () => Effect.die("should not reach the transport"),
        kernelNotifications: Stream.empty,
      });

      const exit = yield* marimo
        .getDependencyTree({
          notebookUri: notebook,
          // @ts-expect-error -- deliberately malformed source
          source: { kind: "conda" },
          inner: {},
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "PackageSource");
    }),
  );

  it.effect(
    "requires tagged-union discriminators before hitting the wire",
    Effect.fn(function* () {
      const marimo = makeMarimoCommands({
        execute: () => Effect.die("should not reach the transport"),
        kernelNotifications: Stream.empty,
      });

      const exit = yield* marimo
        .getDependencyTree({
          notebookUri: notebook,
          // @ts-expect-error -- msgspec requires `kind` for union decoding
          source: { executable: "/usr/bin/python3" },
          inner: {},
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "PackageSource");
    }),
  );
});

describe("findMarimoLspExecutable", () => {
  it.effect("uses a compatible Python range for the bundled LSP", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        NodeFs.mkdtempDisposableSync(
          NodePath.join(NodeOs.tmpdir(), "marimo-lsp-client-"),
        ),
      ),
      (directory) =>
        Effect.gen(function* () {
          const sdist = NodePath.join(directory.path, "marimo_lsp-0.1.0");
          NodeFs.mkdirSync(sdist);

          const executable = yield* findMarimoLspExecutable(
            "bundled-uv",
            directory.path,
          );

          expect(executable).toEqual({
            command: "bundled-uv",
            args: [
              "tool",
              "run",
              "--python",
              ">=3.13,<3.15",
              "--from",
              sdist,
              "marimo-lsp",
            ],
          });
        }),
      (directory) => Effect.sync(() => directory.remove()),
    ),
  );
});

describe("findWasmMarimoLspExecutable", () => {
  it("launches the bundled server with VS Code's Node runtime", () => {
    const executable = findWasmMarimoLspExecutable("/extension/dist");

    expect(executable.command).toBe(process.execPath);
    expect(executable.args).toEqual([
      NodePath.join("/extension/dist", "wasmServer.js"),
    ]);
    expect(executable.options?.env?.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});

describe("selectMarimoLspExecutable", () => {
  it.effect(
    "uses the command carried by the custom server variant",
    Effect.fn(function* () {
      const selection = yield* selectMarimoLspExecutable({
        server: MarimoLspServer.Custom({
          command: ["/custom/marimo-lsp", "--stdio"],
        }),
        resolveUvBinary: Effect.die("custom mode must not resolve uv"),
        searchDirectory: "/does/not/exist",
      });

      expect(selection).toEqual({
        _tag: "Configured",
        exec: { command: "/custom/marimo-lsp", args: ["--stdio"] },
      });
    }),
  );

  it.effect(
    "uses WASM without resolving uv",
    Effect.fn(function* () {
      const selection = yield* selectMarimoLspExecutable({
        server: MarimoLspServer.Wasm(),
        resolveUvBinary: Effect.die("WASM mode must not resolve uv"),
        searchDirectory: "/extension/dist",
      });

      expect(selection._tag).toBe("Wasm");
      expect(selection.exec.args).toEqual([
        NodePath.join("/extension/dist", "wasmServer.js"),
      ]);
    }),
  );

  it.effect("resolves uv only for the Python server variant", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        NodeFs.mkdtempDisposableSync(
          NodePath.join(NodeOs.tmpdir(), "marimo-lsp-selection-"),
        ),
      ),
      (directory) =>
        Effect.gen(function* () {
          const selection = yield* selectMarimoLspExecutable({
            server: MarimoLspServer.Python(),
            resolveUvBinary: Effect.succeed("bundled-uv"),
            searchDirectory: directory.path,
          });

          expect(selection).toEqual({
            _tag: "Uv",
            exec: {
              command: "bundled-uv",
              args: ["run", "--directory", directory.path, "marimo-lsp"],
            },
          });
        }),
      (directory) => Effect.sync(() => directory.remove()),
    ),
  );
});

it.effect(
  "subscribes to kernel notifications",
  Effect.fn(function* () {
    let requestedNotification: string | undefined;
    const marimo = makeMarimoCommands({
      execute: () => Effect.void,
      // Stream.suspend defers to subscription time, so the assertion below
      // still observes that draining `kernelNotifications` evaluated the
      // transport.
      kernelNotifications: Stream.suspend(() => {
        requestedNotification = "marimo/kernelNotification";
        return Stream.empty;
      }),
    });

    yield* marimo.kernelNotifications.pipe(Stream.runDrain);

    assert.strictEqual(requestedNotification, "marimo/kernelNotification");
  }),
);

it.effect(
  "broadcasts kernel notifications without replacing the transport handler",
  Effect.fn(function* () {
    let registrations = 0;
    let notify: ((message: unknown) => void) | undefined;
    const operations = yield* makeKernelNotificationStream((handler) => {
      registrations += 1;
      notify = handler;
      return { dispose() {} };
    });

    const message = {
      notebookUri: notebook,
      sessionId: kernelSessionId("00000000-0000-4000-8000-000000000001"),
      notification: { op: "completed-run", run_id: null },
    } as const;
    const [first, second] = yield* Effect.all(
      [
        operations.pipe(Stream.take(1), Stream.runHead),
        operations.pipe(Stream.take(1), Stream.runHead),
        Effect.gen(function* () {
          yield* Effect.yieldNow;
          assert.ok(notify);
          notify(message);
        }),
      ],
      { concurrency: "unbounded" },
    );

    assert.strictEqual(registrations, 1);
    assert.deepStrictEqual(first, Option.some(message));
    assert.deepStrictEqual(second, Option.some(message));
  }),
);

it.effect(
  "disposes the transport notification handler with its scope",
  Effect.fn(function* () {
    let disposals = 0;

    yield* Effect.scoped(
      makeKernelNotificationStream(() => ({
        dispose() {
          disposals += 1;
        },
      })).pipe(Effect.asVoid),
    );

    expect(disposals).toBe(1);
  }),
);

it.effect(
  "decodes document analysis on its own channel",
  Effect.fn(function* () {
    let notify: ((message: unknown) => void) | undefined;
    const analyses = yield* makeDocumentAnalysisStream((handler) => {
      notify = handler;
      return { dispose() {} };
    });
    const snapshot: DocumentAnalysis = {
      notebookUri: notebook,
      analysis: { op: "variables", variables: [] },
    };

    const [received] = yield* Effect.all(
      [
        analyses.pipe(Stream.take(1), Stream.runHead),
        Effect.gen(function* () {
          yield* Effect.yieldNow;
          assert.ok(notify);
          notify({ notebookUri: notebook, analysis: { op: "datasets" } });
          notify(snapshot);
        }),
      ],
      { concurrency: "unbounded" },
    );

    assert.deepStrictEqual(received, Option.some(snapshot));
  }),
);

it.effect(
  "requires a kernel session ID even for kernel variable snapshots",
  Effect.fn(function* () {
    let notify: ((message: unknown) => void) | undefined;
    const operations = yield* makeKernelNotificationStream((handler) => {
      notify = handler;
      return { dispose() {} };
    });
    const kernelSnapshot: KernelNotification = {
      notebookUri: notebook,
      sessionId: kernelSessionId("00000000-0000-4000-8000-000000000001"),
      notification: { op: "variables", variables: [] },
    };

    const [received] = yield* Effect.all(
      [
        operations.pipe(Stream.take(1), Stream.runHead),
        Effect.gen(function* () {
          yield* Effect.yieldNow;
          assert.ok(notify);
          notify({ ...kernelSnapshot, sessionId: undefined });
          notify(kernelSnapshot);
        }),
      ],
      { concurrency: "unbounded" },
    );

    assert.deepStrictEqual(received, Option.some(kernelSnapshot));
  }),
);
