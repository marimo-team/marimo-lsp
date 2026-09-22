import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";

import {
  createTestNotebookDocument,
  TestVsCode,
  Uri,
} from "../../__mocks__/TestVsCode.ts";
import { kernelSessionId, notebookId } from "../../lib/__tests__/branded.ts";
import {
  LiveSessions,
  type SessionViewItem,
} from "../../panel/sessions/LiveSessions.ts";
import { Catalog } from "../Api.gen.ts";
import { makeLocalDiscoveryCatalog } from "../LocalDiscoveryCatalog.ts";

const CLOSED_URI = Uri.file("/workspace/nested/closed.py");
const CLOSED_NOTEBOOK_ID = notebookId(CLOSED_URI.toString());
const SESSION_ID = kernelSessionId("session-1");

describe("LocalDiscoveryCatalog", () => {
  it.effect(
    "projects open documents and retained sessions into their longest workspace root",
    Effect.fn(function* () {
      const openDocument = createTestNotebookDocument(
        "/workspace/nested/open.py",
      );
      const untitledDocument = createTestNotebookDocument(
        Uri.parse("untitled:Untitled-1"),
      );
      const vscode = yield* TestVsCode.make({
        initialDocuments: [openDocument, untitledDocument],
        fileSystem: new Map([
          [openDocument.uri.toString(), new Uint8Array()],
          [CLOSED_URI.toString(), new Uint8Array()],
        ]),
        workspace: {
          getWorkspaceFolders: Effect.succeed(
            Option.some([
              { uri: Uri.file("/workspace"), name: "workspace", index: 0 },
              {
                uri: Uri.file("/workspace/nested"),
                name: "nested",
                index: 1,
              },
            ]),
          ),
        },
      });
      const initialSessions: ReadonlyArray<SessionViewItem> = [
        {
          sessionId: SESSION_ID,
          notebookUri: CLOSED_NOTEBOOK_ID,
          filename: CLOSED_URI.fsPath,
          executable: "/usr/bin/python",
          workingDirectory: "/workspace/nested",
          startedAt: 1,
          marimoVersion: "0.24.0",
          status: "idle",
          attached: false,
        },
      ];
      const sessions = yield* SubscriptionRef.make(initialSessions);
      const liveSessions: Context.Service.Shape<typeof LiveSessions> = {
        get: SubscriptionRef.get(sessions),
        changes: SubscriptionRef.changes(sessions),
        find: (uri) =>
          Effect.map(SubscriptionRef.get(sessions), (current) =>
            Option.fromNullishOr(
              current.find((session) => session.notebookUri === uri),
            ),
          ),
        refresh: () => Effect.void,
        restart: () => Effect.succeed(undefined),
        shutdown: () => Effect.void,
        restore: () => Effect.void,
        shutdownAll: () => Effect.void,
        move: () => Effect.void,
      };
      const dependencies = Layer.merge(
        vscode.layer,
        Layer.succeed(LiveSessions, liveSessions),
      );

      yield* Effect.gen(function* () {
        const catalog = yield* makeLocalDiscoveryCatalog();
        const value = yield* catalog.snapshot;
        expect(value.projects.map((project) => project.root)).toEqual([
          Uri.file("/workspace").fsPath,
          Uri.file("/workspace/nested").fsPath,
          null,
        ]);
        const nested = value.projects.find(
          (project) => project.root === Uri.file("/workspace/nested").fsPath,
        );
        const retained = nested?.notebooks.find(
          (notebook) => notebook.title === "closed.py",
        );
        if (retained === undefined) {
          throw new Error("Retained notebook missing from catalog");
        }
        const resolvedRetained = yield* catalog.resolveNotebook(retained.id);
        const resolvedSession = yield* catalog.resolveSession(SESSION_ID);
        const encoded = yield* Schema.encodeEffect(Catalog)(value);

        expect({
          catalog: {
            ...encoded,
            instance_id: "<instance-id>",
            projects: encoded.projects.map((project) => ({
              ...project,
              id: `<project:${project.name}>`,
              // Roots above are native paths; keep the snapshot portable.
              root: project.root === null ? null : Uri.file(project.root).path,
              notebooks: project.notebooks.map((notebook) => ({
                ...notebook,
                id: `<notebook:${notebook.title}>`,
              })),
            })),
          },
          resolved: {
            notebook: Option.match(resolvedRetained, {
              onNone: () => null,
              onSome: (target) => ({
                ...target,
                uri: target.uri.toString(),
              }),
            }),
            session: Option.getOrNull(resolvedSession),
          },
        }).toMatchInlineSnapshot(`
          {
            "catalog": {
              "instance_id": "<instance-id>",
              "operations": [
                "catalog.watch",
                "notebook.open",
                "session.execute",
              ],
              "projects": [
                {
                  "id": "<project:workspace>",
                  "name": "workspace",
                  "notebooks": [],
                  "root": "/workspace",
                  "truncated": true,
                },
                {
                  "id": "<project:nested>",
                  "name": "nested",
                  "notebooks": [
                    {
                      "id": "<notebook:closed.py>",
                      "openable": true,
                      "path": "closed.py",
                      "sessions": [
                        {
                          "marimo_version": "0.24.0",
                          "mode": "edit",
                          "session_id": "session-1",
                          "started_at": "1970-01-01T00:00:01.000Z",
                          "status": "running",
                        },
                      ],
                      "title": "closed.py",
                      "updated_at": "1970-01-01T00:00:00.000Z",
                    },
                    {
                      "id": "<notebook:open.py>",
                      "openable": true,
                      "path": "open.py",
                      "sessions": [],
                      "title": "open.py",
                      "updated_at": "1970-01-01T00:00:00.000Z",
                    },
                  ],
                  "root": "/workspace/nested",
                  "truncated": true,
                },
                {
                  "id": "<project:Loose Files>",
                  "name": "Loose Files",
                  "notebooks": [
                    {
                      "id": "<notebook:Untitled-1>",
                      "openable": false,
                      "path": null,
                      "sessions": [],
                      "title": "Untitled-1",
                      "updated_at": null,
                    },
                  ],
                  "root": null,
                  "truncated": false,
                },
              ],
            },
            "resolved": {
              "notebook": {
                "openable": true,
                "uri": "file:///workspace/nested/closed.py",
              },
              "session": {
                "runnable": true,
                "sessionId": "session-1",
              },
            },
          }
        `);

        const changed = yield* catalog.changes.pipe(
          Stream.drop(1),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* SubscriptionRef.set(
          sessions,
          initialSessions.map((session) => ({
            ...session,
            status: "restarting" as const,
          })),
        );
        const updated = yield* catalog.snapshot.pipe(
          Effect.filterOrFail(
            (value) =>
              value.projects.every((project) =>
                project.notebooks.every(
                  (notebook) => notebook.sessions.length === 0,
                ),
              ),
            () => "catalog was not refreshed" as const,
          ),
          Effect.eventually,
        );
        const invalidation = yield* Fiber.join(changed);
        const target = yield* catalog.resolveSession(SESSION_ID);

        expect({
          invalidated: Option.isSome(invalidation),
          sessions: updated.projects.flatMap((project) =>
            project.notebooks.flatMap((notebook) => notebook.sessions),
          ),
          target: Option.getOrNull(target),
        }).toMatchInlineSnapshot(`
          {
            "invalidated": true,
            "sessions": [],
            "target": {
              "runnable": false,
              "sessionId": "session-1",
            },
          }
        `);

        // Keep the notebook visible while its hidden restarting session goes
        // away. Target resolution must refresh without a watch notification.
        const reopened = createTestNotebookDocument(CLOSED_URI);
        yield* vscode.openNotebook(reopened);
        const watching = yield* Deferred.make<void>();
        const watched = yield* catalog.changes.pipe(
          Stream.mapEffect(() => catalog.snapshot),
          Stream.tap(() => Deferred.succeed(watching, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(watching);
        yield* SubscriptionRef.set(sessions, []);
        yield* catalog.resolveSession(SESSION_ID).pipe(
          Effect.filterOrFail(
            Option.isNone,
            () => "session target was not removed",
          ),
          Effect.eventually,
        );
        yield* Effect.yieldNow;
        // A subsequent visible change lets us check the watch stream without
        // waiting for a timeout to prove that no duplicate event arrived.
        yield* vscode.closeNotebook(reopened);
        expect(
          (yield* Fiber.join(watched)).map((value) =>
            value.projects.flatMap((project) =>
              project.notebooks.map((notebook) => notebook.title),
            ),
          ),
        ).toMatchInlineSnapshot(`
          [
            [
              "closed.py",
              "open.py",
              "Untitled-1",
            ],
            [
              "open.py",
              "Untitled-1",
            ],
          ]
        `);
      }).pipe(Effect.provide(dependencies), Effect.scoped);
    }),
  );
});
