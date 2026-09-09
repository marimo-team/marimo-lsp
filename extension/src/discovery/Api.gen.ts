// AUTO-GENERATED FILE — DO NOT EDIT.
// Generated from marimo-desktop/schemas/local-discovery/openapi.yaml.
// Regenerate with `cargo xtask generate-local-discovery`.

import * as Schema from "effect/Schema";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "effect/unstable/httpapi";
// non-recursive definitions
export type SessionMode = "edit" | "app";
export const SessionMode = Schema.Literals(["edit", "app"]).annotate({
  identifier: "SessionMode",
});
export type SessionStatus =
  | "starting"
  | "running"
  | "terminating"
  | "terminated"
  | "failed"
  | "expired";
export const SessionStatus = Schema.Literals([
  "starting",
  "running",
  "terminating",
  "terminated",
  "failed",
  "expired",
]).annotate({ identifier: "SessionStatus" });
export type ConsoleEvent = { readonly data: string };
export const ConsoleEvent = Schema.Struct({ data: Schema.String }).annotate({
  description: "JSON payload of a stdout or stderr SSE event.",
  identifier: "ConsoleEvent",
});
export type OutputData = { readonly data: string; readonly mimetype: string };
export const OutputData = Schema.Struct({
  data: Schema.String,
  mimetype: Schema.String,
}).annotate({ identifier: "OutputData" });
export type ErrorResponse = { readonly message: string };
export const ErrorResponse = Schema.Struct({
  message: Schema.String.annotate({
    description: "Human-readable explanation; must not contain credentials.",
  }),
}).annotate({ identifier: "ErrorResponse" });
export type ExecuteRequest = { readonly code: string };
export const ExecuteRequest = Schema.Struct({ code: Schema.String }).annotate({
  identifier: "ExecuteRequest",
});
export type InstanceRecord = {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly pid: number;
  readonly started_at: string;
  readonly token: string;
  readonly url: string;
};
export const InstanceRecord = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }),
  kind: Schema.String.annotate({
    description:
      "Open application identifier, such as marimo or vscode. Editors may use\ntheir URI scheme. Never infer capabilities or launch URLs from it.\n",
  }),
  name: Schema.String.annotate({
    description:
      "Publisher-chosen plain-text label, defaulting to a concise application\nname and optionally customized. Consumers display it verbatim; it is\nnot unique and must not be used as identity.\n",
    examples: ["marimo"],
  }),
  pid: Schema.Number.annotate({ format: "int64" })
    .check(Schema.isInt().annotate({ expected: "an integer" }))
    .check(
      Schema.isGreaterThanOrEqualTo(1).annotate({
        expected: "a value greater than or equal to 1",
      }),
    ),
  started_at: Schema.String.annotate({ format: "date-time" }),
  token: Schema.String,
  url: Schema.String.annotate({
    description: "HTTP API base URL using literal 127.0.0.1 or [::1].",
  }),
}).annotate({
  description:
    "A running instance writes this record to discovery/v1. Its id must match the\nfilename. Consumers verify owner-only access to the discovery directories\nand record, reject symlinks and files over 64 KiB, and ignore invalid or\nunreachable records. On Windows, verify permissions allowing ownership\nand access only to the current user, SYSTEM, or the built-in\nAdministrators group.\n",
  identifier: "InstanceRecord",
});
export type OpenNotebookResponse = { readonly uri: string };
export const OpenNotebookResponse = Schema.Struct({
  uri: Schema.String.annotate({
    description: "Absolute host-defined launch URI.",
  }),
}).annotate({ identifier: "OpenNotebookResponse" });
export type SessionSummary = {
  readonly marimo_version: string | null;
  readonly mode: SessionMode;
  readonly session_id: string;
  readonly started_at: string;
  readonly status: SessionStatus;
};
export const SessionSummary = Schema.Struct({
  marimo_version: Schema.Union([Schema.String, Schema.Null]),
  mode: SessionMode,
  session_id: Schema.String.annotate({
    description:
      "Opaque ID, unique within the instance and stable while listed.",
  }),
  started_at: Schema.String.annotate({ format: "date-time" }),
  status: SessionStatus,
}).annotate({ identifier: "SessionSummary" });
export type DoneEvent = {
  readonly output: OutputData;
  readonly success: boolean;
};
export const DoneEvent = Schema.Struct({
  output: OutputData,
  success: Schema.Boolean,
}).annotate({
  description: "JSON payload of the terminal done SSE event.",
  identifier: "DoneEvent",
});
export type NotebookSummary = {
  readonly id: string;
  readonly openable: boolean;
  readonly path: string | null;
  readonly sessions: ReadonlyArray<SessionSummary>;
  readonly title: string;
  readonly updated_at: string | null;
};
export const NotebookSummary = Schema.Struct({
  id: Schema.String,
  openable: Schema.Boolean,
  path: Schema.Union([Schema.String, Schema.Null]).annotate({
    description:
      "Native path relative to the project root; null if root is null.",
  }),
  sessions: Schema.Array(SessionSummary),
  title: Schema.String,
  updated_at: Schema.Union([Schema.String, Schema.Null]).annotate({
    description:
      "Best-effort activity time for display, never synchronization.",
    format: "date-time",
  }),
}).annotate({ identifier: "NotebookSummary" });
export type ProjectSummary = {
  readonly id: string;
  readonly name: string;
  readonly notebooks: ReadonlyArray<NotebookSummary>;
  readonly root: string | null;
  readonly truncated: boolean;
};
export const ProjectSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  notebooks: Schema.Array(NotebookSummary),
  root: Schema.Union([Schema.String, Schema.Null]).annotate({
    description:
      "Absolute native workspace path, or null without a filesystem root.",
  }),
  truncated: Schema.Boolean,
}).annotate({ identifier: "ProjectSummary" });
export type Catalog = {
  readonly instance_id: string;
  readonly operations: ReadonlyArray<string>;
  readonly projects: ReadonlyArray<ProjectSummary>;
};
export const Catalog = Schema.Struct({
  instance_id: Schema.String.annotate({ format: "uuid" }),
  operations: Schema.Array(Schema.String).annotate({
    description:
      "Optional operation identifiers; unknown identifiers must be accepted.",
  }),
  projects: Schema.Array(ProjectSummary),
}).annotate({ identifier: "Catalog" });
// schemas
export type LocalDiscoveryProtocol = {
  readonly Catalog: Catalog;
  readonly ConsoleEvent: ConsoleEvent;
  readonly DoneEvent: DoneEvent;
  readonly ErrorResponse: ErrorResponse;
  readonly ExecuteRequest: ExecuteRequest;
  readonly InstanceRecord: InstanceRecord;
  readonly NotebookSummary: NotebookSummary;
  readonly OpenNotebookResponse: OpenNotebookResponse;
  readonly OutputData: OutputData;
  readonly ProjectSummary: ProjectSummary;
  readonly SessionMode: SessionMode;
  readonly SessionStatus: SessionStatus;
  readonly SessionSummary: SessionSummary;
};
export const LocalDiscoveryProtocol = Schema.Struct({
  Catalog: Catalog,
  ConsoleEvent: ConsoleEvent,
  DoneEvent: DoneEvent,
  ErrorResponse: ErrorResponse,
  ExecuteRequest: ExecuteRequest,
  InstanceRecord: InstanceRecord,
  NotebookSummary: NotebookSummary,
  OpenNotebookResponse: OpenNotebookResponse,
  OutputData: OutputData,
  ProjectSummary: ProjectSummary,
  SessionMode: SessionMode,
  SessionStatus: SessionStatus,
  SessionSummary: SessionSummary,
});
// schemas
export type Catalog200 = Catalog;
export const Catalog200 = Catalog;
export type Catalog401 = ErrorResponse;
export const Catalog401 = ErrorResponse;
export type Catalog403 = ErrorResponse;
export const Catalog403 = ErrorResponse;
export type Catalog500 = ErrorResponse;
export const Catalog500 = ErrorResponse;
export type WatchCatalog200Sse = {
  readonly data: string;
  readonly event: "catalog.changed";
};
export const WatchCatalog200Sse = Schema.Struct({
  data: Schema.String.annotate({ description: "JSON-encoded empty object." }),
  event: Schema.Literal("catalog.changed"),
});
export type WatchCatalog200SseError = ErrorResponse;
export const WatchCatalog200SseError = ErrorResponse;
export type WatchCatalog401 = ErrorResponse;
export const WatchCatalog401 = ErrorResponse;
export type WatchCatalog403 = ErrorResponse;
export const WatchCatalog403 = ErrorResponse;
export type WatchCatalog500 = ErrorResponse;
export const WatchCatalog500 = ErrorResponse;
export type OpenNotebookPathParams = { readonly notebook_id: string };
export const OpenNotebookPathParams = Schema.Struct({
  notebook_id: Schema.String,
});
export type OpenNotebook200 = OpenNotebookResponse;
export const OpenNotebook200 = OpenNotebookResponse;
export type OpenNotebook401 = ErrorResponse;
export const OpenNotebook401 = ErrorResponse;
export type OpenNotebook403 = ErrorResponse;
export const OpenNotebook403 = ErrorResponse;
export type OpenNotebook404 = ErrorResponse;
export const OpenNotebook404 = ErrorResponse;
export type OpenNotebook409 = ErrorResponse;
export const OpenNotebook409 = ErrorResponse;
export type OpenNotebook500 = ErrorResponse;
export const OpenNotebook500 = ErrorResponse;
export type ExecutePathParams = { readonly session_id: string };
export const ExecutePathParams = Schema.Struct({ session_id: Schema.String });
export type ExecuteRequestJson = ExecuteRequest;
export const ExecuteRequestJson = ExecuteRequest;
export type Execute200Sse =
  | { readonly data: string; readonly event: "stdout" | "stderr" }
  | { readonly data: string; readonly event: "done" };
export const Execute200Sse = Schema.Union(
  [
    Schema.Struct({
      data: Schema.String.annotate({
        description: "JSON-encoded ConsoleEvent.",
      }),
      event: Schema.Literals(["stdout", "stderr"]),
    }),
    Schema.Struct({
      data: Schema.String.annotate({ description: "JSON-encoded DoneEvent." }),
      event: Schema.Literal("done"),
    }),
  ],
  { mode: "oneOf" },
);
export type Execute200SseError = ErrorResponse;
export const Execute200SseError = ErrorResponse;
export type Execute400 = ErrorResponse;
export const Execute400 = ErrorResponse;
export type Execute401 = ErrorResponse;
export const Execute401 = ErrorResponse;
export type Execute403 = ErrorResponse;
export const Execute403 = ErrorResponse;
export type Execute404 = ErrorResponse;
export const Execute404 = ErrorResponse;
export type Execute409 = ErrorResponse;
export const Execute409 = ErrorResponse;
export type Execute500 = ErrorResponse;
export const Execute500 = ErrorResponse;

export const LocalTokenSecurity = HttpApiSecurity.bearer.pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "The token in the validated instance record. Accept credentials only in\nAuthorization, never cookies or query parameters. Hosts reject\nnon-loopback peers and emit no CORS allow headers. Consumers must not\nfollow redirects or send this token to notebook code or launch URIs.",
  ),
);

export class LocalTokenSecurityMiddleware extends HttpApiMiddleware.Service<LocalTokenSecurityMiddleware>()(
  "localToken security",
  { security: { localToken: LocalTokenSecurity } },
) {}

class DefaultGroup extends HttpApiGroup.make("default", { topLevel: true }).add(
  HttpApiEndpoint.get("catalog", "/catalog", {
    success: Catalog200,
    error: [
      Catalog401.pipe(HttpApiSchema.status(401)),
      Catalog403.pipe(HttpApiSchema.status(403)),
      Catalog500,
    ],
  })
    .middleware(LocalTokenSecurityMiddleware)
    .annotate(OpenApi.Identifier, "catalog")
    .annotate(
      OpenApi.Description,
      "Return a complete, unpaginated snapshot of indexed resources. The\ninstance_id must match the record. A project is truncated whenever\nindexing did not enumerate it exhaustively.",
    ),
  HttpApiEndpoint.get("watchCatalog", "/catalog/watch", {
    success: HttpApiSchema.StreamSse({
      events: WatchCatalog200Sse,
      error: WatchCatalog200SseError,
    }),
    error: [
      WatchCatalog401.pipe(HttpApiSchema.status(401)),
      WatchCatalog403.pipe(HttpApiSchema.status(403)),
      WatchCatalog500,
    ],
  })
    .middleware(LocalTokenSecurityMiddleware)
    .annotate(OpenApi.Identifier, "watch_catalog")
    .annotate(
      OpenApi.Description,
      "Instances offering catalog.watch send catalog.changed with JSON data {}\nwhen the stream opens and whenever the catalog changes. Publishers may combine\npending invalidations, and consumers may handle several with one catalog\nread. If another invalidation arrives during that read, read again.\nThere are no deltas or event replay. Consumers ignore unknown event names.",
    ),
  HttpApiEndpoint.post("openNotebook", "/notebooks/:notebook_id/open", {
    params: OpenNotebookPathParams,
    success: OpenNotebook200,
    error: [
      OpenNotebook401.pipe(HttpApiSchema.status(401)),
      OpenNotebook403.pipe(HttpApiSchema.status(403)),
      OpenNotebook404.pipe(HttpApiSchema.status(404)),
      OpenNotebook409.pipe(HttpApiSchema.status(409)),
      OpenNotebook500,
    ],
  })
    .middleware(LocalTokenSecurityMiddleware)
    .annotate(OpenApi.Identifier, "open_notebook")
    .annotate(
      OpenApi.Description,
      "Requires notebook.open. Return the host-defined launch URI, including\napplication deep links. Consumers open it unchanged and must not attach\nthe discovery token. A notebook that is not openable returns 409.",
    ),
  HttpApiEndpoint.post("execute", "/sessions/:session_id/execute", {
    params: ExecutePathParams,
    payload: ExecuteRequestJson,
    success: HttpApiSchema.StreamSse({
      events: Execute200Sse,
      error: Execute200SseError,
    }),
    error: [
      Execute400.pipe(HttpApiSchema.status(400)),
      Execute401.pipe(HttpApiSchema.status(401)),
      Execute403.pipe(HttpApiSchema.status(403)),
      Execute404.pipe(HttpApiSchema.status(404)),
      Execute409.pipe(HttpApiSchema.status(409)),
      Execute500,
    ],
  })
    .middleware(LocalTokenSecurityMiddleware)
    .annotate(OpenApi.Identifier, "execute")
    .annotate(
      OpenApi.Description,
      "Instances offering session.execute accept code for running sessions\nand return 409 otherwise. Send zero or more ordered stdout/stderr events\nwith ConsoleEvent payloads, followed by exactly one done event with a\nDoneEvent payload. Send done when the requested code and any cells it\ntriggers finish, with success false if either fails.\nPublishers should try to interrupt execution when the consumer disconnects.\nIf the stream ends before done, the consumer cannot know whether execution\ncompleted and must not retry automatically. Consumers ignore unknown event names.",
    ),
) {}

export class LocalDiscoveryApi extends HttpApi.make("LocalDiscoveryApi")
  .annotate(OpenApi.Title, "Local marimo discovery")
  .annotate(OpenApi.Version, "1.0.0")
  .annotate(
    OpenApi.Description,
    "A local host advertises an InstanceRecord in discovery/v1 and serves this\nAPI at the record's URL. JSON does not repeat the protocol version.\nConsumers ignore unknown fields, operation identifiers, and SSE event names.\nBreaking changes require a new major version. Hosts may implement additional\noptional operations; the catalog advertises the ones currently supported.",
  )
  .annotate(OpenApi.Servers, [
    {
      description:
        "Example only; use the URL in the validated instance record.",
      url: "http://127.0.0.1:2718/api/marimo/v1",
    },
  ])
  .add(DefaultGroup) {}
