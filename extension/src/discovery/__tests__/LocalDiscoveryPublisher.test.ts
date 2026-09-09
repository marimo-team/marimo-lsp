import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { Context, Effect, Option, Result, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { afterEach, describe, expect, it } from "vitest";

import { TestVsCode, Uri } from "../../__mocks__/TestVsCode.ts";
import { SCRATCH_CELL_ID } from "../../constants.ts";
import { NotebookRuntime } from "../../kernel/NotebookRuntime.ts";
import { cellId, kernelSessionId } from "../../lib/__tests__/branded.ts";
import type { CellOperationNotification } from "../../types.ts";
import {
  Catalog,
  LocalDiscoveryApi,
  ExecuteRequest,
  OpenNotebookResponse,
} from "../Api.gen.ts";
import { makeLocalDiscoveryCatalog } from "../LocalDiscoveryCatalog.ts";
import { makeLocalDiscoveryPublisher } from "../LocalDiscoveryPublisher.ts";

const INSTANCE_ID = "00000000-0000-4000-8000-000000000001";
const NOTEBOOK_ID = "00000000-0000-5000-8000-000000000001";
const SESSION_ID = kernelSessionId("session-1");

const snapshot = Catalog.make({
  instance_id: INSTANCE_ID,
  operations: ["catalog.watch", "notebook.open", "session.execute"],
  projects: [],
});

const catalog: Effect.Success<ReturnType<typeof makeLocalDiscoveryCatalog>> = {
  instanceId: INSTANCE_ID,
  snapshot: Effect.succeed(snapshot),
  changes: Stream.make(undefined),
  resolveNotebook: (id) =>
    Effect.succeed(
      id === NOTEBOOK_ID
        ? Option.some({
            uri: Uri.file("/workspace/notebook & #.py"),
            openable: true,
          })
        : Option.none(),
    ),
  resolveSession: (id) =>
    Effect.succeed(
      id === SESSION_ID
        ? Option.some({
            sessionId: SESSION_ID,
            runnable: true,
          })
        : Option.none(),
    ),
};

type DiscoveryRuntime = Pick<
  Context.Service.Shape<typeof NotebookRuntime>,
  "executeSessionScratchpad"
>;

const scratchResult: CellOperationNotification = {
  op: "cell-op",
  cell_id: cellId(SCRATCH_CELL_ID),
  output: {
    channel: "output",
    data: { "text/plain": "2" },
    mimetype: "text/plain",
  },
};

function runtimeFrom(
  ...operations: ReadonlyArray<CellOperationNotification>
): DiscoveryRuntime {
  return {
    executeSessionScratchpad: () => Stream.fromIterable(operations),
  };
}

const runtime = runtimeFrom(
  {
    op: "cell-op",
    cell_id: cellId("child"),
    console: {
      channel: "stdout",
      data: "hello\n",
      mimetype: "text/plain",
    },
  },
  scratchResult,
);

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const root = await NodeFs.mkdtemp(
    NodePath.join(NodeOs.tmpdir(), "marimo-publisher-test-"),
  );
  temporaryDirectories.push(root);
  return NodePath.join(root, "marimo", "discovery", "v1");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((root) => NodeFs.rm(root, { recursive: true, force: true })),
  );
});

async function withServer<A>(
  run: (
    baseUrl: string,
    authorized: { Authorization: string },
    token: string,
  ) => Promise<A>,
  testRuntime: DiscoveryRuntime = runtime,
  env: NonNullable<Parameters<typeof TestVsCode.make>[0]>["env"] = {},
): Promise<A> {
  const directory = await temporaryDirectory();
  return await Effect.runPromise(
    Effect.gen(function* () {
      const vscode = yield* TestVsCode.make({ env });
      const record = yield* makeLocalDiscoveryPublisher(
        catalog,
        testRuntime,
        directory,
      ).pipe(Effect.provide(vscode.layer));
      return yield* Effect.promise(() =>
        run(
          record.url,
          { Authorization: `Bearer ${record.token}` },
          record.token,
        ),
      );
    }).pipe(Effect.scoped),
  );
}

async function readEvents(response: Response, limit = Infinity) {
  const events: Array<{ event: string; data: unknown }> = [];
  const parser = Sse.makeParser((event) => {
    if (event._tag === "Event") {
      events.push({ event: event.event, data: JSON.parse(event.data) });
    }
  });
  const body = response.body;
  if (body === null) throw new Error("Missing SSE response body");
  for await (const text of body.pipeThrough(new TextDecoderStream())) {
    const error = parser.feed(text);
    if (error !== undefined) throw error;
    if (events.length >= limit) break;
  }
  return events;
}

describe("local discovery publisher", { timeout: 30_000 }, () => {
  it("removes its record, closes HTTP, and unregisters the URI handler on shutdown", async () => {
    const directory = await temporaryDirectory();
    let handlerRegistered = false;
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        const vscode = yield* TestVsCode.make({
          env: { uriScheme: "cursor", appName: "Cursor" },
          window: {
            registerUriHandler: () =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  handlerRegistered = true;
                }),
                () =>
                  Effect.sync(() => {
                    handlerRegistered = false;
                  }),
              ),
          },
        });
        const record = yield* makeLocalDiscoveryPublisher(
          catalog,
          runtime,
          directory,
        ).pipe(Effect.provide(vscode.layer));
        const published = yield* Effect.promise(() =>
          NodeFs.readFile(
            NodePath.join(directory, `${record.id}.json`),
            "utf8",
          ),
        );
        expect(JSON.parse(published).url).toBe(record.url);
        expect(JSON.parse(published)).toMatchObject({
          kind: "cursor",
          name: "Cursor",
        });
        expect(handlerRegistered).toBe(true);
        return record;
      }).pipe(Effect.scoped),
    );

    expect({
      handlerRegistered,
      records: await NodeFs.readdir(directory),
    }).toEqual({ handlerRegistered: false, records: [] });
    await expect(fetch(`${record.url}/catalog`)).rejects.toThrow();
  });

  it("releases earlier resources when registration fails", async () => {
    const directory = await temporaryDirectory();
    await NodeFs.mkdir(NodePath.dirname(directory), { recursive: true });
    await NodeFs.writeFile(directory, "not a directory");
    const handlers: string[] = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const vscode = yield* TestVsCode.make({
          window: {
            registerUriHandler: () =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  handlers.push("registered");
                }),
                () =>
                  Effect.sync(() => {
                    handlers.push("disposed");
                  }),
              ),
          },
        });
        return yield* makeLocalDiscoveryPublisher(
          catalog,
          runtime,
          directory,
        ).pipe(Effect.provide(vscode.layer));
      }).pipe(Effect.scoped, Effect.result),
    );
    expect({
      failed: Result.isFailure(result),
      handlers,
    }).toEqual({
      failed: true,
      handlers: ["registered", "disposed"],
    });
  });

  it("interrupts execution when the HTTP client disconnects", async () => {
    const started = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<void>();
    await withServer(
      async (baseUrl, authorized) => {
        const response = await fetch(
          `${baseUrl}/sessions/${SESSION_ID}/execute`,
          {
            method: "POST",
            headers: authorized,
            body: JSON.stringify({ code: "while True: pass" }),
          },
        );
        await started.promise;
        await response.body?.cancel();
        await interrupted.promise;
      },
      {
        executeSessionScratchpad: () =>
          Stream.unwrap(
            Effect.sync(() => {
              started.resolve();
              return Stream.never.pipe(
                Stream.ensuring(Effect.sync(() => interrupted.resolve())),
              );
            }),
          ),
      },
    );
  });

  it("interrupts a silent execution when the publisher shuts down", async () => {
    const interrupted = Promise.withResolvers<void>();
    const response = await withServer(
      (baseUrl, authorized) =>
        fetch(`${baseUrl}/sessions/${SESSION_ID}/execute`, {
          method: "POST",
          headers: authorized,
          body: JSON.stringify({ code: "while True: pass" }),
        }),
      {
        executeSessionScratchpad: () =>
          Stream.never.pipe(
            Stream.ensuring(Effect.sync(() => interrupted.resolve())),
          ),
      },
    );
    await interrupted.promise;
    expect(await response.text()).toBe("");
  });

  it("decodes execution events and catches a sanitized stream failure with HttpApiClient", async () => {
    const result = await withServer(
      (baseUrl, _authorized, token) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const client = yield* HttpApiClient.make(LocalDiscoveryApi, {
              baseUrl,
              transformClient: HttpClient.mapRequest(
                HttpClientRequest.bearerToken(token),
              ),
            });
            const stream = yield* client.execute({
              params: { session_id: SESSION_ID },
              payload: { code: "print('hello')" },
            });
            return yield* stream.pipe(
              Stream.map((event) => ({
                ...event,
                data: JSON.parse(event.data),
              })),
              Stream.catch((error) => Stream.succeed(error)),
              Stream.runCollect,
            );
          }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped),
        ),
      {
        executeSessionScratchpad: () =>
          Stream.succeed<CellOperationNotification>({
            op: "cell-op",
            cell_id: cellId(SCRATCH_CELL_ID),
            console: {
              channel: "stdout",
              data: "hello\n",
              mimetype: "text/plain",
            },
          }).pipe(
            Stream.concat(Stream.die(new Error("private kernel details"))),
          ),
      },
    );
    expect(result).toEqual([
      { event: "stdout", data: { data: "hello\n" } },
      { message: "Execution failed" },
    ]);
  });

  it("rejects oversized request bodies and keeps the server available", async () => {
    await withServer(async (baseUrl, authorized) => {
      const response = await fetch(
        `${baseUrl}/sessions/${SESSION_ID}/execute`,
        {
          method: "POST",
          headers: { ...authorized, "Content-Type": "application/json" },
          body: JSON.stringify({ code: "x".repeat(8 * 1024 * 1024) }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "Request body is too large",
      });
      expect(
        (await fetch(`${baseUrl}/catalog`, { headers: authorized })).status,
      ).toBe(200);
    });
  });

  it("requires a strict bearer token and returns a no-store catalog", async () => {
    await withServer(async (baseUrl, _authorized, token) => {
      const [missing, extra, wrongScheme, response] = await Promise.all([
        fetch(`${baseUrl}/catalog`),
        fetch(`${baseUrl}/catalog`, {
          headers: { Authorization: `Bearer ${token} extra` },
        }),
        fetch(`${baseUrl}/catalog`, {
          headers: { Authorization: `Basic ${token}` },
        }),
        fetch(`${baseUrl}/catalog`, {
          headers: { Authorization: `bearer ${token}` },
        }),
      ]);
      expect({
        authentication: {
          missing: missing.status,
          extra: extra.status,
          wrongScheme: wrongScheme.status,
          caseInsensitiveScheme: response.status,
          error: await missing.json(),
        },
        catalog: {
          status: response.status,
          cacheControl: response.headers.get("cache-control"),
          accessControlAllowOrigin: response.headers.get(
            "access-control-allow-origin",
          ),
          body: await response.json(),
        },
      }).toMatchInlineSnapshot(`
        {
          "authentication": {
            "caseInsensitiveScheme": 200,
            "error": {
              "message": "Invalid discovery token",
            },
            "extra": 401,
            "missing": 401,
            "wrongScheme": 401,
          },
          "catalog": {
            "accessControlAllowOrigin": null,
            "body": {
              "instance_id": "00000000-0000-4000-8000-000000000001",
              "operations": [
                "catalog.watch",
                "notebook.open",
                "session.execute",
              ],
              "projects": [],
            },
            "cacheControl": "no-store",
            "status": 200,
          },
        }
      `);
    });
  });

  it.each(["vscode", "cursor", "vscodium"])(
    "returns the window-resolved %s link unchanged",
    async (uriScheme) => {
      const resolved = "https://callback.test/opaque?window=42";
      await withServer(
        async (baseUrl, authorized) => {
          const response = await fetch(
            `${baseUrl}/notebooks/${NOTEBOOK_ID}/open`,
            {
              method: "POST",
              headers: authorized,
            },
          );
          expect(response.status).toBe(200);
          expect(
            Schema.decodeUnknownSync(OpenNotebookResponse)(
              await response.json(),
            ).uri,
          ).toBe(resolved);
        },
        runtime,
        {
          uriScheme,
          asExternalUri: (uri) => {
            expect(uri.scheme).toBe(uriScheme);
            expect(uri.authority).toBe("marimo-team.vscode-marimo");
            expect(uri.path).toBe("/open");
            expect(Object.fromEntries(new URLSearchParams(uri.query))).toEqual({
              uri: "file:///workspace/notebook%20&%20%23.py",
              instance: INSTANCE_ID,
            });
            return Effect.succeed(
              Object.assign(Uri.parse(resolved), { toString: () => resolved }),
            );
          },
        },
      );
    },
  );

  it("sends an immediate catalog invalidation on the watch stream", async () => {
    await withServer(async (baseUrl, authorized) => {
      const response = await fetch(`${baseUrl}/catalog/watch`, {
        headers: authorized,
      });
      expect({
        status: response.status,
        events: await readEvents(response, 1),
      }).toEqual({
        status: 200,
        events: [{ event: "catalog.changed", data: {} }],
      });
    });
  });

  it("streams stdout followed by exactly one done event", async () => {
    await withServer(async (baseUrl, authorized) => {
      const response = await fetch(
        `${baseUrl}/sessions/${SESSION_ID}/execute`,
        {
          method: "POST",
          headers: { ...authorized, "Content-Type": "application/json" },
          body: JSON.stringify(ExecuteRequest.make({ code: "1 + 1" })),
        },
      );
      expect({
        status: response.status,
        events: await readEvents(response),
      }).toEqual({
        status: 200,
        events: [
          { event: "stdout", data: { data: "hello\n" } },
          {
            event: "done",
            data: {
              success: true,
              output: { mimetype: "text/plain", data: "2" },
            },
          },
        ],
      });
    });
  });

  it("validates the execute request with the protocol schema", async () => {
    await withServer(async (baseUrl, authorized) => {
      const response = await fetch(
        `${baseUrl}/sessions/${SESSION_ID}/execute`,
        {
          method: "POST",
          headers: { ...authorized, "Content-Type": "application/json" },
          body: JSON.stringify({ code: 42 }),
        },
      );
      expect({
        status: response.status,
        body: await response.json(),
      }).toMatchInlineSnapshot(`
        {
          "body": {
            "message": "Request body must contain a string 'code' field",
          },
          "status": 400,
        }
      `);
    });
  });

  it("reports child errors but ignores ancestor-stopped", async () => {
    const execute = (testRuntime: DiscoveryRuntime) =>
      withServer(async (baseUrl, authorized) => {
        const response = await fetch(
          `${baseUrl}/sessions/${SESSION_ID}/execute`,
          {
            method: "POST",
            headers: { ...authorized, "Content-Type": "application/json" },
            body: JSON.stringify(ExecuteRequest.make({ code: "1 + 1" })),
          },
        );
        return readEvents(response);
      }, testRuntime);

    const error = (data: CellOperationNotification["output"]) =>
      runtimeFrom(
        {
          op: "cell-op",
          cell_id: cellId("child"),
          output: data,
        },
        scratchResult,
      );

    expect({
      childError: await execute(
        error({
          channel: "marimo-error",
          mimetype: "application/vnd.marimo+error",
          data: [
            {
              type: "exception",
              msg: "ValueError: bad child",
              exception_type: "ValueError",
            },
          ],
        }),
      ),
      ancestorStopped: await execute(
        error({
          channel: "marimo-error",
          mimetype: "application/vnd.marimo+error",
          data: [
            {
              type: "ancestor-stopped",
              msg: "Ancestor cell was stopped",
              raising_cell: "parent",
            },
          ],
        }),
      ),
    }).toEqual({
      ancestorStopped: [
        {
          event: "done",
          data: {
            success: true,
            output: { mimetype: "text/plain", data: "2" },
          },
        },
      ],
      childError: [
        {
          event: "done",
          data: {
            success: false,
            output: { mimetype: "text/plain", data: "" },
          },
        },
      ],
    });
  });
});

it.each([
  {
    data: { "text/plain": "<literal>", "text/html": "<b>rich</b>" },
    mimetype: "text/html",
    expected: { mimetype: "text/plain", data: "<literal>" },
  },
  {
    data: { "text/html": "<b>rich</b>" },
    mimetype: "application/json",
    expected: { mimetype: "text/html", data: "<b>rich</b>" },
  },
] as const)(
  "labels the selected output representation consistently ($mimetype)",
  async ({ data, mimetype, expected }) => {
    await withServer(
      async (baseUrl, authorized) => {
        const response = await fetch(
          `${baseUrl}/sessions/${SESSION_ID}/execute`,
          {
            method: "POST",
            headers: { ...authorized, "Content-Type": "application/json" },
            body: JSON.stringify({ code: "value" }),
          },
        );
        expect(await readEvents(response)).toEqual([
          { event: "done", data: { success: true, output: expected } },
        ]);
      },
      runtimeFrom({
        ...scratchResult,
        output: { channel: "output", mimetype, data },
      }),
    );
  },
);
