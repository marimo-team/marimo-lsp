import { expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Layer,
  Logger,
  Option,
  Queue,
  Redacted,
  Stream,
} from "effect";
import { vi } from "vite-plus/test";
import type * as vscode from "vscode";

import { TestExtensionContextLive } from "../../__mocks__/TestExtensionContext.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { MarimoCommandError } from "../../lsp/MarimoClient.ts";
import { Telemetry } from "../Telemetry.ts";

interface TestSentryOptions {
  readonly beforeSend: (event: Record<string, unknown>) => unknown;
}

const sentrySdk = vi.hoisted(() => ({
  init: vi.fn<(options: TestSentryOptions) => void>(),
  setTag: vi.fn(),
  setUser: vi.fn(),
  close: vi.fn(async () => true),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

const posthog = vi.hoisted(() => ({
  instances: [] as Array<{ capture: ReturnType<typeof vi.fn> }>,
  capture: vi.fn(),
  shutdown: vi.fn(async () => undefined),
}));

vi.mock("@sentry/node", () => sentrySdk);

vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = posthog.capture;
    shutdown = posthog.shutdown;
  },
}));

const telemetryChange: vscode.ConfigurationChangeEvent = {
  affectsConfiguration: (section) => section === "marimo.telemetry",
};

const withTestCtx = Effect.fn(function* (options?: { telemetry?: boolean }) {
  sentrySdk.init.mockClear();
  sentrySdk.close.mockClear();
  sentrySdk.setTag.mockClear();
  sentrySdk.captureMessage.mockClear();
  sentrySdk.addBreadcrumb.mockClear();
  posthog.capture.mockClear();
  posthog.shutdown.mockClear();

  let telemetry = options?.telemetry ?? true;
  // A Queue (not a PubSub) so events published before the service's forked
  // fiber subscribes are buffered instead of dropped.
  const changes = yield* Queue.unbounded<vscode.ConfigurationChangeEvent>();
  const vscodeMock = yield* TestVsCode.make({
    workspace: {
      configurationChanges: () => Stream.fromQueue(changes),
      getConfiguration: (section) =>
        Effect.succeed({
          // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
          get: <T>(key: string, defaultValue?: T) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            return (
              section === "marimo" && key === "telemetry"
                ? telemetry
                : defaultValue
            ) as T;
          },
          has: (key: string) => section === "marimo" && key === "telemetry",
          inspect: () => undefined,
          async update() {},
        }),
    },
  });

  const context = yield* Layer.build(
    Telemetry.Default.pipe(
      Layer.provide(vscodeMock.layer),
      Layer.provide(TestExtensionContextLive),
    ),
  );

  return {
    telemetry: yield* Telemetry.pipe(Effect.provide(context)),
    setTelemetry: (value: boolean) =>
      Effect.suspend(() => {
        telemetry = value;
        return Queue.offer(changes, telemetryChange);
      }),
  };
});

const waitFor = (assertion: () => void) =>
  Effect.promise(() => vi.waitFor(assertion));

it.scoped("releases both sinks on consent loss and re-acquires them", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx();
    expect(sentrySdk.init).toHaveBeenCalledTimes(1);
    // Activation event goes to PostHog on acquire
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "extension_activated" }),
    );

    yield* ctx.setTelemetry(false);
    yield* waitFor(() => expect(sentrySdk.close).toHaveBeenCalledTimes(1));
    expect(posthog.shutdown).toHaveBeenCalledTimes(1);

    yield* ctx.setTelemetry(true);
    yield* waitFor(() => expect(sentrySdk.init).toHaveBeenCalledTimes(2));
  }),
);

it.scoped(
  "a sink that throws neither fails construction nor kills consent tracking",
  () =>
    Effect.gen(function* () {
      sentrySdk.init.mockImplementationOnce(() => {
        throw new Error("sentry exploded");
      });

      // Consent is on but acquisition fails: construction must survive
      // and capture must degrade to a no-op.
      const ctx = yield* withTestCtx();
      yield* ctx.telemetry.capture("new_notebook_created");
      expect(posthog.capture).not.toHaveBeenCalled();

      // The consent watcher must still be alive: toggling off and on
      // re-acquires the sinks now that the SDK behaves again.
      yield* ctx.setTelemetry(false);
      yield* ctx.setTelemetry(true);
      yield* waitFor(() => expect(sentrySdk.init).toHaveBeenCalledTimes(2));

      yield* ctx.telemetry.capture("new_notebook_created");
      expect(posthog.capture).toHaveBeenCalledWith(
        expect.objectContaining({ event: "new_notebook_created" }),
      );
    }),
);

it.scoped("capture is a no-op without consent, live with it", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx({ telemetry: false });
    expect(sentrySdk.init).not.toHaveBeenCalled();

    yield* ctx.telemetry.capture("new_notebook_created");
    expect(posthog.capture).not.toHaveBeenCalled();

    yield* ctx.setTelemetry(true);
    yield* waitFor(() => expect(sentrySdk.init).toHaveBeenCalledTimes(1));

    yield* ctx.telemetry.capture("new_notebook_created");
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "new_notebook_created" }),
    );
  }),
);

it.scoped("contains synchronous capture failures", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx();
    posthog.capture.mockClear();
    posthog.capture.mockImplementationOnce(() => {
      throw new Error("posthog exploded");
    });

    // Reporting failures must not escape into the product effect.
    yield* ctx.telemetry.capture("new_notebook_created");
    expect(posthog.capture).toHaveBeenCalledTimes(1);

    // A failed capture does not disable later telemetry.
    yield* ctx.telemetry.capture("new_notebook_created");
    expect(posthog.capture).toHaveBeenCalledTimes(2);
  }),
);

it.scoped("redacts user data from classified and unexpected errors", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx();
    const source = "DO_NOT_UPLOAD_123 = 'notebook source'";
    const secondCell = "print('DO_NOT_UPLOAD_SECOND_CELL')";
    const localPath = "/Users/alice/private/customer-notebook.py";
    const environmentSecret = "DO_NOT_UPLOAD_API_TOKEN";
    const commandError = new MarimoCommandError({
      command: Redacted.make({
        command: "marimo.api",
        params: {
          method: "execute-cells",
          params: {
            notebookUri: `file://${localPath}`,
            executable: "/private/venv/bin/python",
            workingDirectory: "/Users/alice/private",
            inner: { cellIds: ["one", "two"], codes: [source, secondCell] },
          },
        },
      }),
      cause: {
        name: "ResponseError",
        code: -32603,
        message: source,
        stack: `ResponseError: ${source}\n    at rpcDispatch (${localPath}:1:1)`,
      },
    });
    commandError.stack = `MarimoCommandError: ${source}\n    at deserialize (${localPath}:1:1)`;
    const unexpected = {
      name: "UnexpectedConverterError",
      message: source,
      data: { source, environment: { API_TOKEN: environmentSecret } },
      stack: `UnexpectedConverterError: ${source}\n    at convert (${localPath}:1:1)`,
    };
    const cause = Cause.parallel(
      Cause.fail(commandError),
      Cause.die(unexpected),
    );

    yield* Effect.logError(source).pipe(
      Effect.annotateLogs({
        cause,
        "error.tag": "MarimoCommandError",
        rawCells: [source, secondCell],
        environment: { API_TOKEN: environmentSecret },
        notebookUri: localPath,
      }),
      Effect.provide(
        Logger.replace(Logger.defaultLogger, ctx.telemetry.errorLogger),
      ),
    );
    yield* Effect.logWarning(source).pipe(
      Effect.annotateLogs({ rawCells: [source], notebookUri: localPath }),
      Effect.provide(
        Logger.replace(Logger.defaultLogger, ctx.telemetry.errorLogger),
      ),
    );

    const payload = JSON.stringify({
      events: sentrySdk.captureMessage.mock.calls,
      breadcrumbs: sentrySdk.addBreadcrumb.mock.calls,
    });
    expect(payload).not.toContain(source);
    expect(payload).not.toContain(secondCell);
    expect(payload).not.toContain(localPath);
    expect(payload).not.toContain(environmentSecret);
    expect(sentrySdk.captureMessage.mock.calls).toMatchInlineSnapshot(`
      [
        [
          "marimo extension error",
          {
            "extra": {
              "cause": {
                "defects": [
                  {
                    "exceptionClass": "UnexpectedConverterError",
                  },
                ],
                "failures": [
                  {
                    "exceptionClass": "MarimoCommandError",
                  },
                ],
              },
              "error.tag": "MarimoCommandError",
            },
            "fingerprint": [
              "marimo extension error",
              "MarimoCommandError",
            ],
            "level": "error",
            "tags": {
              "error.tag": "MarimoCommandError",
              "marimo": "true",
            },
          },
        ],
      ]
    `);
  }),
);

it.scoped("retains safe diagnostics from Cause log messages", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx();
    const secret = "DO_NOT_UPLOAD_CAUSE_MESSAGE";

    yield* Effect.logError(
      Cause.fail({ name: "ResponseError", code: -32603, message: secret }),
    ).pipe(
      Effect.provide(
        Logger.replace(Logger.defaultLogger, ctx.telemetry.errorLogger),
      ),
    );

    const payload = sentrySdk.captureMessage.mock.calls[0]?.[1];
    expect(payload?.extra).toEqual({
      "logger.cause": {
        failures: [{ exceptionClass: "ResponseError", rpcCode: -32603 }],
        defects: [],
      },
    });
    expect(JSON.stringify(payload)).not.toContain(secret);
  }),
);

it.scoped("sanitizes SDK events at the final Sentry boundary", () =>
  Effect.gen(function* () {
    yield* withTestCtx();
    const secret = "DO_NOT_UPLOAD_BEFORE_SEND";
    const localPath = "/Users/alice/private/customer-notebook.py";
    const initOptions = Option.getOrThrow(
      Option.fromNullable(sentrySdk.init.mock.calls[0]?.[0]),
    );

    const result = initOptions.beforeSend({
      message: secret,
      request: { data: secret },
      contexts: { private: { secret } },
      server_name: secret,
      extra: {
        "error.domain": "notebook.deserialize",
        private: secret,
      },
      logentry: { message: secret },
      exception: {
        values: [
          {
            type: "ResponseError",
            value: secret,
            stacktrace: {
              frames: [
                {
                  filename: `/marimo${localPath}`,
                  abs_path: localPath,
                  function: "customerFunction",
                  module: "customerModule",
                  context_line: secret,
                  vars: { secret },
                  lineno: 7,
                },
              ],
            },
          },
        ],
      },
    });

    const payload = JSON.stringify(result);
    expect(payload).not.toContain(secret);
    expect(payload).not.toContain("customer-notebook.py");
    expect(payload).not.toContain("customerFunction");
    expect(result).toMatchObject({
      message: "marimo extension error",
      extra: { "error.domain": "notebook.deserialize" },
      exception: {
        values: [
          {
            type: "ResponseError",
            value: "marimo extension error",
            stacktrace: { frames: [{ lineno: 7 }] },
          },
        ],
      },
    });
  }),
);

it.scoped("groups notebook deserialize failures by safe classification", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx();

    yield* Effect.logError("Notebook deserialize failed").pipe(
      Effect.annotateLogs({
        "error.domain": "notebook.deserialize",
        "error.kind": "rpc.internal",
        "error.exception_class": "ResponseError",
        "rpc.method": "deserialize",
        "rpc.code": -32603,
      }),
      Effect.provide(
        Logger.replace(Logger.defaultLogger, ctx.telemetry.errorLogger),
      ),
    );

    expect(sentrySdk.captureMessage).toHaveBeenCalledWith(
      "marimo extension error",
      expect.objectContaining({
        fingerprint: [
          "notebook.deserialize",
          "rpc.internal",
          "-32603",
          "ResponseError",
        ],
        tags: expect.objectContaining({
          "error.domain": "notebook.deserialize",
          "error.kind": "rpc.internal",
          "rpc.method": "deserialize",
          "rpc.code": "-32603",
        }),
      }),
    );
  }),
);

it.scoped("does not retain error annotations created without consent", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx({ telemetry: false });

    yield* ctx.telemetry.annotateErrors({ "uv.version": "off" });
    expect(sentrySdk.setTag).not.toHaveBeenCalled();

    yield* ctx.setTelemetry(true);
    yield* waitFor(() => expect(sentrySdk.init).toHaveBeenCalledTimes(1));
    sentrySdk.setTag.mockClear();
    yield* ctx.telemetry.annotateErrors({ "uv.version": "on" });
    expect(sentrySdk.setTag).toHaveBeenCalledWith("uv.version", "on");

    yield* ctx.setTelemetry(false);
    yield* waitFor(() => expect(sentrySdk.close).toHaveBeenCalledTimes(1));
    sentrySdk.setTag.mockClear();
    yield* ctx.telemetry.annotateErrors({ "uv.version": "off-again" });
    expect(sentrySdk.setTag).not.toHaveBeenCalled();
  }),
);
