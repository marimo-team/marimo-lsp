import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node";
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  Headers,
  HttpBody,
  HttpIncomingMessage,
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi";
import type * as vscode from "vscode";

import openAsMarimoNotebook from "../commands/openAsMarimoNotebook.ts";
import { SCRATCH_CELL_ID } from "../constants.ts";
import { makeCellRunState, transitionCell } from "../kernel/CellRunReducer.ts";
import { NotebookRuntime } from "../kernel/NotebookRuntime.ts";
import { VsCode } from "../platform/VsCode.ts";
import type { CellOperationNotification } from "../types.ts";
import {
  ConsoleEvent,
  type Execute200Sse,
  LocalDiscoveryApi,
  LocalTokenSecurityMiddleware,
  DoneEvent,
  ErrorResponse,
  InstanceRecord,
  OpenNotebookResponse,
} from "./Api.gen.ts";
import { makeLocalDiscoveryCatalog } from "./LocalDiscoveryCatalog.ts";
import { DISCOVERY_API_PATH } from "./LocalDiscoveryProtocol.ts";
import { registerDiscoveryRecord } from "./LocalDiscoveryRegistry.ts";

const DiscoveryApi = LocalDiscoveryApi.prefix(DISCOVERY_API_PATH);
const encodeConsoleEvent = Schema.encodeSync(
  Schema.fromJsonString(ConsoleEvent),
);
const encodeDoneEvent = Schema.encodeSync(Schema.fromJsonString(DoneEvent));

const EXTENSION_AUTHORITY = "marimo-team.vscode-marimo";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const EMPTY_OUTPUT = { mimetype: "text/plain", data: "" } as const;
const EDITOR_DISPLAY_NAMES = new Map([
  ["vscode", "VS Code"],
  ["vscode-insiders", "VS Code Insiders"],
  ["code-oss", "Code - OSS"],
  ["cursor", "Cursor"],
  ["vscodium", "VSCodium"],
  ["vscodium-insiders", "VSCodium Insiders"],
  ["positron", "Positron"],
]);
type CellOutput = NonNullable<CellOperationNotification["output"]>;

class PublisherStartupError extends Data.TaggedError("PublisherStartupError")<{
  readonly cause: unknown;
}> {}

function isAuthorized(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (authorization === undefined) return false;
  const separator = authorization.indexOf(" ");
  if (separator < 0) return false;
  const scheme = authorization.slice(0, separator);
  const token = authorization.slice(separator + 1);
  if (scheme.toLowerCase() !== "bearer") return false;
  const actual = Buffer.from(token, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return (
    actual.byteLength === expected.byteLength &&
    NodeCrypto.timingSafeEqual(actual, expected)
  );
}

function errorResponse(status: number, message: string) {
  return HttpServerResponse.jsonUnsafe(ErrorResponse.make({ message }), {
    status,
    headers: status === 401 ? { "www-authenticate": "Bearer" } : undefined,
  });
}

/** Enforce discovery's HTTP contract around the schema-based handlers. */
function discoveryMiddleware(token: string) {
  return HttpRouter.middleware(
    (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const address = Option.getOrUndefined(request.remoteAddress);
        const response = yield* Effect.gen(function* () {
          if (address !== "127.0.0.1" && address !== "::ffff:127.0.0.1") {
            return errorResponse(403, "Loopback connection required");
          }
          // Protect unmatched routes as well as the generated API endpoints.
          if (!isAuthorized(request.headers.authorization, token)) {
            return errorResponse(401, "Invalid discovery token");
          }
          // Reject a declared oversized body before the platform reader closes
          // its socket. MaxBodySize also bounds bodies without Content-Length.
          if (Number(request.headers["content-length"]) > MAX_REQUEST_BYTES) {
            return errorResponse(400, "Request body is too large");
          }
          // Preserve JSON sent with fetch's default string-body content type.
          const contentType = request.headers["content-type"]?.split(";", 1)[0];
          return yield* httpEffect.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              contentType === "text/plain"
                ? request.modify({
                    headers: Headers.set(
                      request.headers,
                      "content-type",
                      "application/json",
                    ),
                  })
                : request,
            ),
          );
        }).pipe(
          Effect.provideService(
            HttpIncomingMessage.MaxBodySize,
            FileSystem.Size(MAX_REQUEST_BYTES),
          ),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
            const error = Cause.squash(cause);
            if (
              HttpApiError.HttpApiSchemaError.is(error) &&
              error.kind === "Payload"
            ) {
              return Effect.succeed(
                errorResponse(
                  400,
                  "Request body must contain a string 'code' field",
                ),
              );
            }
            if (HttpServerError.isHttpServerError(error)) {
              if (error.reason._tag === "RouteNotFound") {
                return Effect.succeed(errorResponse(404, "Not found"));
              }
              if (error.reason._tag === "RequestParseError") {
                return Effect.succeed(
                  errorResponse(400, "Invalid or oversized request body"),
                );
              }
            }
            return Effect.logWarning("Local discovery request failed").pipe(
              Effect.annotateLogs({ cause }),
              Effect.as(errorResponse(500, "Internal server error")),
            );
          }),
        );
        const secured = HttpServerResponse.setHeader(
          response,
          "cache-control",
          "no-store",
        );
        if (
          secured.body._tag !== "Stream" ||
          !secured.body.contentType.startsWith("text/event-stream")
        ) {
          return secured;
        }
        // NodeHttpServer writes headers before consuming the body. Flush them at
        // that point so a silent execution still lets its client connect/cancel.
        const body = secured.body;
        return secured.pipe(
          HttpServerResponse.setHeaders({
            connection: "keep-alive",
            "x-accel-buffering": "no",
          }),
          HttpServerResponse.setBody(
            HttpBody.stream(
              Stream.suspend(() => {
                NodeHttpServerRequest.toServerResponse(request).flushHeaders();
                return body.stream;
              }),
              body.contentType,
            ),
          ),
        );
      }),
    { global: true },
  );
}

function outputDataAsString(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data) ?? "";
  } catch {
    return "";
  }
}

/** Ignore propagated failures; the originating cell determines run success. */
function isOnlyAncestorStopped(output: CellOutput): boolean {
  return (
    output.channel === "marimo-error" &&
    Array.isArray(output.data) &&
    output.data.length > 0 &&
    output.data.every(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "type" in error &&
        error.type === "ancestor-stopped",
    )
  );
}

function makeDoneEvent(
  scratchOutput: CellOutput | undefined,
  childErrored: boolean,
) {
  const scratchErrored = scratchOutput?.channel === "marimo-error";
  const success = !scratchErrored && !childErrored;
  if (!success || scratchOutput?.channel !== "output") {
    return DoneEvent.make({ success, output: EMPTY_OUTPUT });
  }

  let data: unknown = scratchOutput.data;
  let mimetype = scratchOutput.mimetype;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    if ("text/plain" in data) {
      data = data["text/plain"];
      mimetype = "text/plain";
    } else if ("text/html" in data) {
      data = data["text/html"];
      mimetype = "text/html";
    }
  }
  return DoneEvent.make({
    success: true,
    output: {
      mimetype,
      data: typeof data === "string" ? data : outputDataAsString(data),
    },
  });
}

function streamExecution<E>(
  stream: Stream.Stream<CellOperationNotification, E>,
): Stream.Stream<Execute200Sse, ErrorResponse> {
  return Stream.suspend(() => {
    let scratchState = makeCellRunState().state;
    let childErrored = false;
    return stream.pipe(
      Stream.map((operation) => {
        const events: Execute200Sse[] = [];
        if (operation.cell_id === SCRATCH_CELL_ID) {
          scratchState = transitionCell(scratchState, operation);
        } else if (
          operation.output?.channel === "marimo-error" &&
          Array.isArray(operation.output.data) &&
          operation.output.data.length > 0 &&
          !isOnlyAncestorStopped(operation.output)
        ) {
          childErrored = true;
        }
        const outputs = Array.isArray(operation.console)
          ? operation.console
          : operation.console == null
            ? []
            : [operation.console];
        for (const output of outputs) {
          if (output.channel === "stdout" || output.channel === "stderr") {
            events.push({
              event: output.channel,
              data: encodeConsoleEvent({
                data: outputDataAsString(output.data),
              }),
            });
          }
        }
        return events;
      }),
      Stream.flattenIterable,
      Stream.concat(
        Stream.sync(
          (): Execute200Sse => ({
            event: "done",
            data: encodeDoneEvent(
              makeDoneEvent(scratchState.output ?? undefined, childErrored),
            ),
          }),
        ),
      ),
      Stream.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause))
          return Stream.fromEffect(Effect.interrupt);
        return Stream.fromEffect(
          Effect.logWarning("Local discovery execution failed").pipe(
            Effect.annotateLogs({ cause }),
            Effect.andThen(
              Effect.fail(ErrorResponse.make({ message: "Execution failed" })),
            ),
          ),
        );
      }),
    );
  });
}

function discoveryHandlers(
  code: Context.Service.Shape<typeof VsCode>,
  catalog: Effect.Success<ReturnType<typeof makeLocalDiscoveryCatalog>>,
  runtime: Pick<
    Context.Service.Shape<typeof NotebookRuntime>,
    "executeSessionScratchpad"
  >,
) {
  return HttpApiBuilder.group(DiscoveryApi, "default", (handlers) =>
    handlers
      .handle("catalog", () => catalog.snapshot)
      .handle("watchCatalog", () =>
        Effect.succeed(
          catalog.changes.pipe(
            Stream.map(() => ({
              event: "catalog.changed" as const,
              data: "{}",
            })),
          ),
        ),
      )
      .handle(
        "openNotebook",
        Effect.fn("LocalDiscoveryPublisher.open")(function* ({ params }) {
          const target = yield* catalog.resolveNotebook(params.notebook_id);
          if (Option.isNone(target))
            return errorResponse(404, "Notebook not found");
          if (!target.value.openable)
            return errorResponse(409, "Notebook is not openable");
          const query = new URLSearchParams({
            uri: target.value.uri.toString(),
            instance: catalog.instanceId,
          });
          // Resolve at request time so the link routes to this window.
          const uri = yield* code.env.asExternalUri(
            target.value.uri.with({
              scheme: code.env.uriScheme,
              authority: EXTENSION_AUTHORITY,
              path: "/open",
              query: query.toString(),
              fragment: "",
            }),
          );
          return OpenNotebookResponse.make({ uri: uri.toString() });
        }),
      )
      .handle(
        "execute",
        Effect.fn("LocalDiscoveryPublisher.execute")(function* ({
          params,
          payload,
        }) {
          const target = yield* catalog.resolveSession(params.session_id);
          if (Option.isNone(target))
            return errorResponse(404, "Session not found");
          if (!target.value.runnable)
            return errorResponse(409, "Session is not running");
          return streamExecution(
            runtime.executeSessionScratchpad(
              target.value.sessionId,
              payload.code,
            ),
          );
        }),
      ),
  );
}

function uriHandler(
  uri: vscode.Uri,
  instanceId: string,
  code: Context.Service.Shape<typeof VsCode>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (uri.path !== "/open") return;
    const query = new URLSearchParams(uri.query);
    const rawTarget = query.get("uri");
    if (query.get("instance") !== instanceId || rawTarget === null) {
      yield* Effect.logWarning("Ignored invalid local discovery deep link");
      return;
    }
    const target = code.utils.parseUri(rawTarget);
    if (Result.isFailure(target) || target.success.scheme !== "file") {
      yield* Effect.logWarning("Ignored invalid local discovery deep link");
      return;
    }
    yield* openAsMarimoNotebook
      .invoke(target.success)
      .pipe(Effect.provideService(VsCode, code));
  });
}

function platformDisabledReason(
  code: Context.Service.Shape<typeof VsCode>,
): string | undefined {
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    return "unsupported platform";
  }
  if (code.env.remoteName !== undefined) return "remote extension host";
  if (!code.workspace.isTrusted()) return "untrusted workspace";
  return undefined;
}

/** Publish discovery until the enclosing scope closes. */
export const makeLocalDiscoveryPublisher = Effect.fn(
  "LocalDiscoveryPublisher.make",
)(function* (
  catalog: Effect.Success<ReturnType<typeof makeLocalDiscoveryCatalog>>,
  runtime: Pick<
    Context.Service.Shape<typeof NotebookRuntime>,
    "executeSessionScratchpad"
  >,
  directory?: string,
) {
  const code = yield* VsCode;
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  const startedAt = new Date();

  // Register before publishing the record so every returned deep link has
  // a live handler, even for a client that discovers us immediately.
  yield* code.window.registerUriHandler((uri) =>
    uriHandler(uri, catalog.instanceId, code),
  );

  const routes = HttpApiBuilder.layer(DiscoveryApi).pipe(
    Layer.provide(
      discoveryHandlers(code, catalog, runtime).pipe(
        Layer.provide(
          Layer.succeed(LocalTokenSecurityMiddleware, {
            // The global middleware also protects unmatched routes.
            localToken: (httpEffect) => httpEffect,
          }),
        ),
      ),
    ),
    Layer.merge(discoveryMiddleware(token)),
  );
  const context = yield* Layer.build(
    HttpRouter.serve(routes, {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
          disablePreemptiveShutdown: true,
        }),
      ),
    ),
  );
  const { address } = Context.get(context, HttpServer.HttpServer);
  if (address._tag !== "TcpAddress") {
    return yield* new PublisherStartupError({
      cause: "Discovery server did not bind a TCP port",
    });
  }
  const port = address.port;
  const record = InstanceRecord.make({
    id: catalog.instanceId,
    kind: code.env.uriScheme,
    name: EDITOR_DISPLAY_NAMES.get(code.env.uriScheme) ?? code.env.appName,
    pid: process.pid,
    started_at: startedAt.toISOString(),
    url: `http://127.0.0.1:${port}${DISCOVERY_API_PATH}`,
    token,
  });
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => registerDiscoveryRecord(record, directory),
      catch: (cause) => new PublisherStartupError({ cause }),
    }),
    (registration) =>
      Effect.promise(() => registration.deregister()).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Local discovery publisher cleanup failed").pipe(
            Effect.annotateLogs({ cause }),
          ),
        ),
      ),
  );
  yield* Effect.logDebug("Local discovery publisher started").pipe(
    Effect.annotateLogs({ url: record.url }),
  );
  return record;
});

export const LocalDiscoveryLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const disabledReason = platformDisabledReason(code);
    if (disabledReason !== undefined) {
      yield* Effect.logDebug("Local discovery publisher is disabled").pipe(
        Effect.annotateLogs({ reason: disabledReason }),
      );
      return;
    }

    const scope = yield* Scope.fork(yield* Effect.scope);
    yield* Effect.gen(function* () {
      const catalog = yield* makeLocalDiscoveryCatalog();
      const runtime = yield* NotebookRuntime;
      yield* makeLocalDiscoveryPublisher(catalog, runtime);
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Local discovery publisher failed to start").pipe(
              Effect.annotateLogs({ cause }),
            ),
      ),
    );
  }),
);
