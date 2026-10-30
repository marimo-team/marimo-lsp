import * as Vitest from "@effect/vitest";
import * as SentrySDK from "@sentry/node";
import { Effect, Redacted } from "effect";
import { vi } from "vite-plus/test";

import * as MarimoClient from "../../src/lsp/MarimoClient.ts";
import { classifyNotebookDeserializeError } from "../../src/telemetry/classifyNotebookDeserializeError.ts";
import {
  acquireSentryAdapter,
  classifySentryError,
} from "../../src/telemetry/sentrySink.ts";

// Tests share a module cache; reload the adapter so it sees this transport mock.
vi.hoisted(() => vi.resetModules());
vi.mock("@sentry/node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/node")>()),
}));

Vitest.it.live(
  "delivers scoped errors and flushes on release without replacing the host client",
  Effect.fn(function* () {
    const envelopes: Parameters<
      ReturnType<typeof SentrySDK.makeNodeTransport>["send"]
    >[0][] = [];
    const flush = vi.fn(async () => true);
    const init = SentrySDK.initWithoutDefaultIntegrations;
    let client: SentrySDK.NodeClient | undefined;
    // Keep the real SDK pipeline, replacing only its network transport.
    const initialize = vi
      .spyOn(SentrySDK, "initWithoutDefaultIntegrations")
      .mockImplementation((options) => {
        client = init({
          ...options,
          transport: () => ({
            send: async (envelope) => {
              envelopes.push(envelope);
              return { statusCode: 200 };
            },
            flush,
          }),
        });
        return client;
      });
    const globalScope = SentrySDK.getCurrentScope();
    const previousClient = globalScope.getClient();
    const hostClient = new SentrySDK.NodeClient({
      integrations: [],
      transport: () => ({ send: async () => ({}), flush: async () => true }),
      stackParser: SentrySDK.defaultStackParser,
    });
    globalScope.setClient(hostClient);
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* acquireSentryAdapter({
            appHost: "desktop",
            appName: "Visual Studio Code",
            machineId: "test-machine",
            extensionVersion: "1.2.3",
          });
          Vitest.expect(globalScope.getClient()).toBe(hostClient);
          Vitest.expect(client?.getOptions().enableOpenTelemetrySetup).toBe(
            false,
          );
          Vitest.expect(
            client?.getOptions().integrations.map(({ name }) => name),
          ).toEqual(["LinkedErrors", "ExtraErrorData", "SpanStreaming"]);
          Vitest.expect(client?.getDataCollectionOptions()).toMatchObject({
            userInfo: false,
            cookies: false,
            httpHeaders: { request: false, response: false },
            httpBodies: [],
            urlQueryParams: false,
            genAI: { inputs: false, outputs: false },
            databaseQueryData: false,
            queues: false,
            graphQL: { document: false, variables: false },
          });
          adapter.addBreadcrumb("Opening notebook", "info");
          adapter.setLspMode("wasm");
          adapter.captureError(new Error("Notebook failed"), {
            "error.domain": "notebook",
            "error.kind": "test",
          });
        }),
      );
      Vitest.expect(flush).toHaveBeenCalled();
      Vitest.expect(client?.getOptions().enabled).toBe(false);
      Vitest.expect(globalScope.getClient()).toBe(hostClient);
      Vitest.expect(envelopes).toHaveLength(1);
      Vitest.expect(envelopes[0]?.[1]).toEqual([
        [
          { type: "event" },
          Vitest.expect.objectContaining({
            release: "vscode-marimo@1.2.3",
            user: { id: "test-machine" },
            fingerprint: ["notebook", "test"],
            tags: Vitest.expect.objectContaining({ "marimo_lsp.mode": "wasm" }),
            breadcrumbs: [
              Vitest.expect.objectContaining({ message: "Opening notebook" }),
            ],
            exception: Vitest.expect.objectContaining({
              values: [
                Vitest.expect.objectContaining({ value: "Notebook failed" }),
              ],
            }),
          }),
        ],
      ]);
    } finally {
      globalScope.setClient(previousClient);
      initialize.mockRestore();
    }
  }),
);

function commandError(cause: Error): MarimoClient.CommandError {
  return new MarimoClient.CommandError({
    command: Redacted.make({
      kind: "parse-notebook",
      source: "",
    }),
    cause,
    mode: "wasm",
  });
}

function rpcCommandError(rootCause: Error): MarimoClient.CommandError {
  return commandError(
    Object.assign(new Error("An error has occurred", { cause: rootCause }), {
      name: "ResponseError",
      code: -32603,
    }),
  );
}

function deserializeErrorData(error: MarimoClient.CommandError) {
  const classification = classifyNotebookDeserializeError(error);
  return {
    "error.domain": classification.domain,
    "error.kind": classification.kind,
    ...classification.safeContext,
  };
}

Vitest.it("fingerprints command errors by their nested Python failure", () => {
  const kernelError = rpcCommandError(
    new Error(
      "marimo_lsp.kernels.KernelOpenError: Kernel bridge exited unexpectedly (code=1, signal=jsnull)",
    ),
  );
  const kernelExit = classifySentryError(
    kernelError,
    deserializeErrorData(kernelError),
  );
  const duplicateError = rpcCommandError(
    new Error("ValueError: Cell 'xXTn' already exists"),
  );
  const duplicateCell = classifySentryError(
    duplicateError,
    deserializeErrorData(duplicateError),
  );
  const duplicateStableIdError = rpcCommandError(
    new Error(
      "marimo_lsp.app_file_manager.DuplicateCellIdError: Notebook contains duplicate stable cell IDs: DnEU",
    ),
  );
  const duplicateStableId = classifySentryError(
    duplicateStableIdError,
    deserializeErrorData(duplicateStableIdError),
  );

  Vitest.expect(kernelExit).toEqual({
    tags: {
      "error.domain": "notebook.deserialize",
      "error.exception_class": "KernelOpenError",
      "error.kind": "marimo-command.kernel-bridge-exit",
      "rpc.method": "parse-notebook",
      "rpc.code": "-32603",
      "lsp.mode": "wasm",
    },
    fingerprint: ["marimo command error", "kernel-bridge-exit"],
  });
  Vitest.expect(duplicateCell.fingerprint).toEqual([
    "marimo command error",
    "duplicate-cell-id",
  ]);
  Vitest.expect(duplicateStableId.fingerprint).toEqual(
    duplicateCell.fingerprint,
  );
  Vitest.expect(duplicateStableId.tags["error.exception_class"]).toBe(
    "DuplicateCellIdError",
  );
  Vitest.expect(kernelExit.fingerprint).not.toEqual(duplicateCell.fingerprint);
});

Vitest.it(
  "preserves specific transport classifications for command failures",
  () => {
    const error = commandError(new Error("Client is not running"));

    Vitest.expect(
      classifySentryError(error, deserializeErrorData(error)),
    ).toEqual({
      tags: {
        "error.domain": "notebook.deserialize",
        "error.exception_class": "Error",
        "error.kind": "transport.client-not-running",
        "rpc.method": "parse-notebook",
        "lsp.mode": "wasm",
      },
      fingerprint: [
        "notebook.deserialize",
        "transport.client-not-running",
        "Error",
      ],
    });
  },
);
