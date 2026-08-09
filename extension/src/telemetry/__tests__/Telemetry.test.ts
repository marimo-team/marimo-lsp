import { expect, it } from "@effect/vitest";
import { Cause, Effect, Layer, Logger } from "effect";
import { vi } from "vite-plus/test";
import type * as vscode from "vscode";

import { TestExtensionContextLive } from "../../__mocks__/TestExtensionContext.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { BinarySource } from "../../lib/binaryResolution.ts";
import { Storage } from "../../platform/Storage.ts";
import { acquirePostHogAdapter } from "../posthogSink.ts";
import { makeAcquireSentryAdapter, type SentryRuntime } from "../sentrySink.ts";
import { makeTelemetry, Telemetry } from "../Telemetry.ts";

type TestSentryClient = { readonly name: string };
type TestSentryIntegration = { readonly name: string };

const sentrySdk = {
  init: vi.fn((_options: unknown): TestSentryClient | undefined => ({
    name: "test Sentry client",
  })),
  close: vi.fn(async (_client: TestSentryClient, _timeout: number) => true),
  setClient: vi.fn(),
  setTags: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  linkedErrorsIntegration: vi.fn(() => ({ name: "LinkedErrors" })),
  extraErrorDataIntegration: vi.fn(() => ({ name: "ExtraErrorData" })),
  globalClient: { name: "existing Sentry client" },
  globalSetClient: vi.fn(),
};

const sentryRuntime: SentryRuntime<
  object,
  TestSentryClient,
  TestSentryIntegration
> = {
  createScope: () => ({}),
  setTags: (_scope, tags) => sentrySdk.setTags(tags),
  setUser: (_scope, user) => sentrySdk.setUser(user),
  getCurrentClient: () => sentrySdk.globalClient,
  setCurrentClient: (client) => sentrySdk.globalSetClient(client),
  init: (options) => sentrySdk.init(options),
  linkedErrorsIntegration: () => sentrySdk.linkedErrorsIntegration(),
  extraErrorDataIntegration: () => sentrySdk.extraErrorDataIntegration(),
  setClient: (_scope, client) => sentrySdk.setClient(client),
  close: (client, timeout) => sentrySdk.close(client, timeout),
  captureException: (_scope, error, hint) =>
    sentrySdk.captureException(error, hint),
  addBreadcrumb: (_scope, breadcrumb, maxBreadcrumbs) =>
    sentrySdk.addBreadcrumb(breadcrumb, maxBreadcrumbs),
  setTag: (_scope, key, value) => sentrySdk.setTag(key, value),
};

const posthog = {
  constructed: vi.fn(),
  capture: vi.fn(),
  shutdown: vi.fn(async () => undefined),
};

const withTestCtx = Effect.fn(function* (options?: {
  telemetry?: boolean;
  usageEnabled?: boolean;
  errorsEnabled?: boolean;
  sentryFailure?: boolean;
  loggerFailure?: boolean;
}) {
  for (const mock of [
    sentrySdk.close,
    sentrySdk.setClient,
    sentrySdk.setTags,
    sentrySdk.setTag,
    sentrySdk.setUser,
    sentrySdk.addBreadcrumb,
    sentrySdk.captureException,
    sentrySdk.linkedErrorsIntegration,
    sentrySdk.extraErrorDataIntegration,
    sentrySdk.globalSetClient,
    posthog.constructed,
    posthog.capture,
    posthog.shutdown,
  ]) {
    mock.mockReset();
  }
  sentrySdk.init.mockReset();
  if (options?.sentryFailure) {
    sentrySdk.init.mockImplementationOnce(() => {
      throw new Error("sentry exploded");
    });
  } else {
    sentrySdk.init.mockReturnValue({ name: "test Sentry client" });
  }
  sentrySdk.close.mockResolvedValue(true);
  posthog.shutdown.mockResolvedValue(undefined);

  const loggerCreated = vi.fn();
  const loggerOptionsSeen = vi.fn();
  const vscodeMock = yield* TestVsCode.make({
    env: {
      createTelemetryLogger(sender, loggerOptions) {
        if (options?.loggerFailure) {
          return Effect.die(new Error("VS Code telemetry exploded"));
        }
        return Effect.acquireRelease(
          Effect.sync(() => {
            loggerCreated();
            loggerOptionsSeen(loggerOptions);
            const common = {
              "common.vscodeversion": "1.100.0",
              ...loggerOptions?.additionalCommonProperties,
            };
            const withCommon = (data: Record<string, unknown> = {}) => ({
              ...data,
              ...common,
            });
            const prefix = (event: string) =>
              `marimo-team.vscode-marimo/${event}`;

            return {
              isUsageEnabled: options?.usageEnabled ?? true,
              isErrorsEnabled: options?.errorsEnabled ?? true,
              onDidChangeEnableStates: () => ({ dispose() {} }),
              logUsage(event, data) {
                if (options?.usageEnabled === false) return;
                sender.sendEventData(prefix(event), withCommon(data));
              },
              logError(eventOrError, data) {
                if (options?.errorsEnabled === false) return;
                if (typeof eventOrError === "string") {
                  sender.sendEventData(prefix(eventOrError), withCommon(data));
                  return;
                }
                const cleanedError = new Error(eventOrError.message, {
                  cause:
                    eventOrError.cause instanceof Error
                      ? {}
                      : eventOrError.cause,
                });
                cleanedError.name = eventOrError.name;
                cleanedError.stack = eventOrError.stack;
                sender.sendErrorData(cleanedError, withCommon(data));
              },
              dispose() {},
            } satisfies vscode.TelemetryLogger;
          }),
          (logger) => Effect.sync(() => logger.dispose()),
        );
      },
    },
    workspace: {
      getConfiguration: (section) =>
        Effect.succeed({
          // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
          get: <T>(key: string, defaultValue?: T) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            return (
              section === "marimo" && key === "telemetry"
                ? (options?.telemetry ?? true)
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
    Layer.scoped(
      Telemetry,
      makeTelemetry({
        acquireSentry: makeAcquireSentryAdapter(sentryRuntime),
        acquirePostHog: () =>
          acquirePostHogAdapter(() => {
            posthog.constructed();
            return {
              capture: posthog.capture,
              shutdown: posthog.shutdown,
            };
          }),
      }).pipe(Effect.map(Telemetry.make)),
    ).pipe(
      Layer.provide(vscodeMock.layer),
      Layer.provide(Storage.Default),
      Layer.provide(TestExtensionContextLive),
    ),
  );

  return {
    telemetry: yield* Telemetry.pipe(Effect.provide(context)),
    loggerCreated,
    loggerOptionsSeen,
  };
});

it.scoped(
  "does not acquire telemetry resources when disabled",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx({ telemetry: false });

    expect(ctx.loggerCreated).not.toHaveBeenCalled();
    expect(sentrySdk.init).not.toHaveBeenCalled();
    expect(posthog.constructed).not.toHaveBeenCalled();
    yield* ctx.telemetry.notebookCreated();
    expect(posthog.capture).not.toHaveBeenCalled();
  }),
);

it.scoped(
  "does not fail activation when VS Code telemetry fails",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx({ loggerFailure: true });

    yield* ctx.telemetry.notebookCreated();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(sentrySdk.captureException).not.toHaveBeenCalled();
    expect(sentrySdk.init).not.toHaveBeenCalled();
    expect(posthog.constructed).not.toHaveBeenCalled();
  }),
);

it.scoped(
  "does not subscribe the private adapters to unhandled extension-host errors",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();

    expect(ctx.loggerOptionsSeen).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreUnhandledErrors: true }),
    );
  }),
);

it.scoped(
  "routes stable product events through VS Code",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();

    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "extension_activated",
        properties: expect.objectContaining({
          extension_version: expect.any(String),
          "common.vscodeversion": "1.100.0",
        }),
      }),
    );

    yield* ctx.telemetry.notebookCreated();
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "new_notebook_created" }),
    );
    expect(sentrySdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        skipOpenTelemetrySetup: true,
        normalizeDepth: 8,
      }),
    );
    expect(sentrySdk.globalSetClient).toHaveBeenCalledWith(
      sentrySdk.globalClient,
    );
  }),
);

it.scoped(
  "attributes successful marimo-lsp starts to the selected runtime",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    posthog.capture.mockClear();

    yield* ctx.telemetry.lspModeSelected("wasm");
    yield* ctx.telemetry.lspStarted("wasm");

    expect(sentrySdk.setTag).toHaveBeenCalledWith("marimo_lsp.mode", "wasm");
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "marimo_lsp_started",
        properties: expect.objectContaining({ mode: "wasm" }),
      }),
    );
  }),
);

it.scoped(
  "preserves Error type, trace, cause, and structured diagnostics",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    const inner = new Error("invalid wire type");
    const error = Object.assign(
      new Error("Failed to decode notebook response", { cause: inner }),
      { stderr: "converter exited with code 2" },
    );
    error.name = "UnexpectedConverterError";
    error.stack = `${error.name}: ${error.message}\n    at convert (extension.js:7:3)`;

    yield* Effect.logError("Notebook deserialize failed").pipe(
      Effect.annotateLogs({
        cause: Cause.fail(error),
        "error.domain": "notebook.deserialize",
        "error.kind": "rpc.internal",
        "error.exception_class": "UnexpectedConverterError",
        "rpc.code": -32603,
      }),
      Effect.provide(
        Logger.replace(Logger.defaultLogger, ctx.telemetry.errorLogger),
      ),
    );

    const [captured, hint] = sentrySdk.captureException.mock.calls[0];
    expect(captured).not.toBe(error);
    expect(captured.cause).not.toBe(inner);
    expect(captured).toMatchObject({
      name: "UnexpectedConverterError",
      message: "Failed to decode notebook response",
      stderr: "converter exited with code 2",
      cause: {
        name: "Error",
        message: "invalid wire type",
      },
    });
    expect(captured.stack).toContain("at convert");
    expect(hint.captureContext).toMatchObject({
      fingerprint: [
        "notebook.deserialize",
        "rpc.internal",
        "-32603",
        "UnexpectedConverterError",
      ],
      tags: {
        "error.domain": "notebook.deserialize",
        "error.kind": "rpc.internal",
        "error.exception_class": "UnexpectedConverterError",
        "rpc.code": "-32603",
      },
      extra: {
        cause: {
          failures: [
            {
              name: "UnexpectedConverterError",
              message: "Failed to decode notebook response",
              stack: expect.stringContaining("at convert"),
              stderr: "converter exited with code 2",
              cause: {
                name: "Error",
                message: "invalid wire type",
              },
            },
          ],
        },
      },
    });
  }),
);

it.scoped(
  "retains non-Error Effect failures",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();

    yield* Effect.logError(Cause.fail("uv exited with code 2")).pipe(
      Effect.provide(
        Logger.replace(Logger.defaultLogger, ctx.telemetry.errorLogger),
      ),
    );

    const [error, hint] = sentrySdk.captureException.mock.calls[0];
    expect(error).toMatchObject({
      name: "UnknownFailure",
      message: "uv exited with code 2",
    });
    expect(hint.captureContext.extra.cause.failures).toEqual([
      "uv exited with code 2",
    ]);
  }),
);

it.scoped(
  "uses log context when the native Error message is not diagnostic",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    const timeout = new Cause.TimeoutException();

    yield* Effect.logError("Notebook deserialize failed").pipe(
      Effect.annotateLogs({ cause: Cause.fail(timeout) }),
      Effect.provide(
        Logger.replace(Logger.defaultLogger, ctx.telemetry.errorLogger),
      ),
    );

    const [captured] = sentrySdk.captureException.mock.calls[0];
    expect(captured).toMatchObject({
      name: "TimeoutException",
      message: "Notebook deserialize failed",
    });
    expect(captured.stack).toContain(
      "TimeoutException: Notebook deserialize failed",
    );

    sentrySdk.captureException.mockClear();
    const generic = new Error("An error has occurred");
    generic.name = "UvExecutionError";
    yield* Effect.logError("uv command failed").pipe(
      Effect.annotateLogs({ cause: Cause.fail(generic) }),
      Effect.provide(
        Logger.replace(Logger.defaultLogger, ctx.telemetry.errorLogger),
      ),
    );

    expect(sentrySdk.captureException.mock.calls[0]?.[0]).toMatchObject({
      name: "UvExecutionError",
      message: "uv command failed",
    });
  }),
);

it.scoped(
  "keeps error-tag fingerprint grouping",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();

    yield* Effect.logError("Notebook serialization failed").pipe(
      Effect.annotateLogs({ "error.tag": "NotebookSerializeError" }),
      Effect.provide(
        Logger.replace(Logger.defaultLogger, ctx.telemetry.errorLogger),
      ),
    );

    expect(
      sentrySdk.captureException.mock.calls[0]?.[1].captureContext.fingerprint,
    ).toEqual(["marimo extension error", "NotebookSerializeError"]);
  }),
);

it.scoped(
  "keeps message-only breadcrumbs in VS Code error-only mode",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx({
      usageEnabled: false,
      errorsEnabled: true,
    });
    expect(posthog.capture).not.toHaveBeenCalled();

    yield* Effect.logWarning("language server retrying").pipe(
      Effect.annotateLogs({ server: "ty", attempt: 2 }),
      Effect.provide(
        Logger.replace(Logger.defaultLogger, ctx.telemetry.errorLogger),
      ),
    );

    expect(sentrySdk.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "marimo",
        message: "language server retrying",
        level: "warning",
        data: undefined,
      }),
      100,
    );
  }),
);

it.scoped(
  "respects VS Code error gating independently",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx({
      usageEnabled: true,
      errorsEnabled: false,
    });

    yield* Effect.logError("language server failed").pipe(
      Effect.provide(
        Logger.replace(Logger.defaultLogger, ctx.telemetry.errorLogger),
      ),
    );

    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "extension_activated" }),
    );
    expect(sentrySdk.captureException).not.toHaveBeenCalled();
  }),
);

it.scoped(
  "reports each resolved binary once with exact version context",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    posthog.capture.mockClear();

    yield* ctx.telemetry.binaryResolved({
      server: "uv",
      source: "Bundled",
      version: "0.8.3 (abc123 2026-08-03)",
    });
    expect(sentrySdk.setTag).toHaveBeenCalledWith(
      "uv.version",
      "0.8.3 (abc123 2026-08-03)",
    );
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "uv_init",
        properties: expect.objectContaining({
          binType: "Bundled",
          version: "0.8.3 (abc123 2026-08-03)",
        }),
      }),
    );

    yield* ctx.telemetry.binaryResolved({
      server: "ruff",
      resolved: BinarySource.CompanionExtension({
        extensionId: "charliermarsh.ruff",
        path: "/ruff",
        kind: "bundled",
      }),
      version: "0.15.0",
    });
    expect(sentrySdk.setTag).toHaveBeenCalledWith("ruff.version", "0.15.0");
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "lsp_binary_resolved",
        properties: expect.objectContaining({
          server: "ruff",
          source: "CompanionExtension",
          kind: "bundled",
          version: "0.15.0",
        }),
      }),
    );
  }),
);

it.scoped(
  "gates binary Sentry context independently from usage events",
  Effect.fn(function* () {
    const errorsOnly = yield* withTestCtx({
      usageEnabled: false,
      errorsEnabled: true,
    });
    yield* errorsOnly.telemetry.binaryResolved({
      server: "ty",
      resolved: BinarySource.UserConfigured({ path: "/ty" }),
      version: "0.0.63",
    });
    expect(sentrySdk.setTag).toHaveBeenCalledWith("ty.version", "0.0.63");
    expect(posthog.capture).not.toHaveBeenCalled();

    const usageOnly = yield* withTestCtx({
      usageEnabled: true,
      errorsEnabled: false,
    });
    yield* usageOnly.telemetry.binaryResolved({
      server: "ty",
      resolved: BinarySource.UserConfigured({ path: "/ty" }),
      version: "0.0.63",
    });
    expect(sentrySdk.setTag).not.toHaveBeenCalled();
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "lsp_binary_resolved" }),
    );
  }),
);

it.scoped(
  "contains independent vendor failures",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx({ sentryFailure: true });

    yield* ctx.telemetry.notebookCreated();
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "new_notebook_created" }),
    );

    posthog.capture.mockImplementationOnce(() => {
      throw new Error("posthog exploded");
    });
    yield* ctx.telemetry.notebookCreated();
    yield* ctx.telemetry.notebookCreated();
    expect(posthog.capture).toHaveBeenCalledTimes(4);
  }),
);

it.effect(
  "closes both private adapters with the extension scope",
  Effect.fn(function* () {
    yield* Effect.scoped(withTestCtx());
    expect(sentrySdk.close).toHaveBeenCalledTimes(1);
    expect(posthog.shutdown).toHaveBeenCalledTimes(1);
  }),
);
