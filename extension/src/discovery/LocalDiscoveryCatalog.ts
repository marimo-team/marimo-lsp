import * as NodePath from "node:path";

import {
  Effect,
  Option,
  Result,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";

import { LiveSessions } from "../panel/sessions/LiveSessions.ts";
import type { SessionViewItem } from "../panel/sessions/LiveSessions.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookDocument,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import type { KernelSessionId } from "../schemas/Models.gen.ts";
import {
  Catalog,
  NotebookSummary,
  ProjectSummary,
  SessionSummary,
} from "./Api.gen.ts";
import { DISCOVERY_OPERATIONS, uuidV5 } from "./LocalDiscoveryProtocol.ts";

interface NotebookTarget {
  readonly uri: vscode.Uri;
  readonly openable: boolean;
}

interface SessionTarget {
  readonly sessionId: KernelSessionId;
  readonly runnable: boolean;
}

interface NotebookEntry {
  readonly notebookUri: NotebookId;
  readonly uri: vscode.Uri;
  readonly filename: string | null;
  readonly sessions: ReadonlyArray<SessionViewItem>;
}

interface ProjectEntry {
  readonly id: string;
  readonly name: string;
  readonly root: string | null;
  readonly truncated: boolean;
  readonly folder?: vscode.WorkspaceFolder;
  readonly notebooks: NotebookEntry[];
}

function containsPath(parent: string, child: string): boolean {
  const relative = NodePath.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !NodePath.isAbsolute(relative))
  );
}

function titleFor(entry: NotebookEntry): string {
  if (entry.filename !== null) return NodePath.basename(entry.filename);
  if (entry.uri.scheme === "file") return NodePath.basename(entry.uri.fsPath);
  return NodePath.basename(entry.uri.path) || "Untitled";
}

const encodeCatalog = Schema.encodeSync(Catalog);

/**
 * Projects VS Code notebook and retained-kernel state into discovery v1.
 *
 * Catalog data and action targets share one snapshot, so notifications and
 * route resolution cannot observe different source projections.
 */
export const makeLocalDiscoveryCatalog = Effect.fn(
  "LocalDiscoveryCatalog.make",
)(function* () {
  const code = yield* VsCode;
  const liveSessions = yield* LiveSessions;
  const instanceId = crypto.randomUUID();
  const activity = new Map<NotebookId, Date>();

  const projectCatalog = Effect.fnUntraced(function* () {
    const [rawDocuments, sessions, maybeFolders] = yield* Effect.all([
      code.workspace.getNotebookDocuments,
      liveSessions.get,
      code.workspace.getWorkspaceFolders,
    ]);
    const folders = Option.getOrElse(maybeFolders, () => []);
    const entries = new Map<NotebookId, NotebookEntry>();

    for (const document of rawDocuments) {
      const notebook = MarimoNotebookDocument.tryFrom(document);
      if (Option.isNone(notebook)) continue;
      entries.set(notebook.value.id, {
        notebookUri: notebook.value.id,
        uri: notebook.value.uri,
        filename: null,
        sessions: [],
      });
    }
    for (const session of sessions) {
      const parsed = code.utils.parseUri(session.notebookUri);
      if (Result.isFailure(parsed)) continue;
      const existing = entries.get(session.notebookUri);
      entries.set(session.notebookUri, {
        notebookUri: session.notebookUri,
        uri: existing?.uri ?? parsed.success,
        filename: existing?.filename ?? session.filename,
        sessions: [...(existing?.sessions ?? []), session],
      });
    }

    const projects: ProjectEntry[] = folders.map((folder) => ({
      id: uuidV5(instanceId, `project:${folder.uri.toString()}`),
      name: folder.name,
      root: folder.uri.scheme === "file" ? folder.uri.fsPath : null,
      truncated: true,
      folder,
      notebooks: [],
    }));
    let loose: ProjectEntry | undefined;
    for (const entry of entries.values()) {
      const containing =
        entry.uri.scheme === "file"
          ? projects
              .filter(
                (project) =>
                  project.folder?.uri.scheme === "file" &&
                  containsPath(project.folder.uri.fsPath, entry.uri.fsPath),
              )
              .toSorted(
                (left, right) =>
                  (right.root?.length ?? 0) - (left.root?.length ?? 0),
              )[0]
          : undefined;
      if (containing !== undefined) {
        containing.notebooks.push(entry);
        continue;
      }
      loose ??= {
        id: uuidV5(instanceId, "project:loose-files"),
        name: "Loose Files",
        root: null,
        truncated: false,
        notebooks: [],
      };
      loose.notebooks.push(entry);
    }
    if (loose !== undefined) projects.push(loose);

    const notebookTargets = new Map<string, NotebookTarget>();
    const sessionTargets = new Map<string, SessionTarget>();
    const summaries = yield* Effect.forEach(
      projects,
      Effect.fn(function* (project) {
        const notebooks = yield* Effect.forEach(
          project.notebooks,
          Effect.fn(function* (entry) {
            const stat =
              entry.uri.scheme === "file"
                ? yield* code.workspace.fs.stat(entry.uri).pipe(Effect.option)
                : Option.none<vscode.FileStat>();
            const openable =
              entry.uri.scheme === "file" &&
              Option.exists(stat, (value) => (value.type & 1) === 1);
            let updatedAt = activity.get(entry.notebookUri);
            if (updatedAt === undefined && Option.isSome(stat)) {
              updatedAt = new Date(stat.value.mtime);
              activity.set(entry.notebookUri, updatedAt);
            }
            const id = uuidV5(instanceId, `notebook:${entry.notebookUri}`);
            notebookTargets.set(id, {
              uri: entry.uri,
              openable,
            });
            const visibleSessions = entry.sessions
              .filter((session) => session.status !== "restarting")
              .map((session) =>
                SessionSummary.make({
                  session_id: session.sessionId,
                  status: "running",
                  mode: "edit",
                  started_at: new Date(session.startedAt * 1000).toISOString(),
                  marimo_version: session.marimoVersion,
                }),
              )
              .toSorted((left, right) =>
                left.session_id.localeCompare(right.session_id),
              );
            for (const session of entry.sessions) {
              sessionTargets.set(session.sessionId, {
                sessionId: session.sessionId,
                runnable: session.status !== "restarting",
              });
            }
            return NotebookSummary.make({
              id,
              title: titleFor(entry),
              openable,
              path:
                project.root !== null && entry.uri.scheme === "file"
                  ? NodePath.relative(project.root, entry.uri.fsPath)
                  : null,
              updated_at: updatedAt?.toISOString() ?? null,
              sessions: visibleSessions,
            });
          }),
          { concurrency: "unbounded" },
        );
        return ProjectSummary.make({
          id: project.id,
          name: project.name,
          root: project.root,
          truncated: project.truncated,
          notebooks: notebooks.toSorted((left, right) =>
            (left.path ?? left.id).localeCompare(right.path ?? right.id),
          ),
        });
      }),
    );
    const catalog = Catalog.make({
      instance_id: instanceId,
      operations: DISCOVERY_OPERATIONS,
      projects: summaries,
    });
    return {
      catalog,
      notebooks: notebookTargets,
      sessions: sessionTargets,
      fingerprint: JSON.stringify(encodeCatalog(catalog)),
    };
  });

  const initialSessions = yield* liveSessions.get;
  const state = yield* SubscriptionRef.make(yield* projectCatalog());
  const refresh = Effect.fn("LocalDiscoveryCatalog.refresh")(function* () {
    yield* SubscriptionRef.updateEffect(state, () => projectCatalog());
  });

  let previousSessions: ReadonlyArray<SessionViewItem> = initialSessions;
  const lifecycle = yield* code.workspace.subscribeNotebookLifecycle;
  yield* Effect.forkScoped(lifecycle.pipe(Stream.runForEach(() => refresh())));
  yield* Effect.forkScoped(
    code.workspace.notebookDocumentSaved.pipe(
      Stream.runForEach((document) => {
        const notebook = MarimoNotebookDocument.tryFrom(document);
        if (Option.isNone(notebook)) return Effect.void;
        activity.set(notebook.value.id, new Date());
        return refresh();
      }),
    ),
  );
  yield* Effect.forkScoped(
    liveSessions.changes.pipe(
      Stream.runForEach((sessions) => {
        const prior = new Map(
          previousSessions.map((session) => [session.sessionId, session]),
        );
        for (const session of sessions) {
          if (
            prior.get(session.sessionId)?.status === "running" &&
            session.status === "idle"
          ) {
            activity.set(session.notebookUri, new Date());
          }
        }
        previousSessions = sessions;
        return refresh();
      }),
    ),
  );
  yield* Effect.forkScoped(
    code.workspace.workspaceFoldersChanges.pipe(
      Stream.runForEach(() => refresh()),
    ),
  );
  yield* Effect.forkScoped(
    Stream.merge(code.workspace.fileRenames, code.workspace.fileDeletes).pipe(
      Stream.runForEach(() => refresh()),
    ),
  );

  // Reconcile after listeners start so cached reads cannot miss a source
  // transition during initialization.
  yield* refresh();

  return {
    instanceId,
    snapshot: SubscriptionRef.get(state).pipe(
      Effect.map((value) => value.catalog),
    ),
    changes: SubscriptionRef.changes(state).pipe(
      Stream.map((value) => value.fingerprint),
      Stream.changes,
      Stream.map(() => undefined),
    ),
    resolveNotebook(id: string) {
      return SubscriptionRef.get(state).pipe(
        Effect.map((value) => Option.fromNullishOr(value.notebooks.get(id))),
      );
    },
    resolveSession(id: string) {
      return SubscriptionRef.get(state).pipe(
        Effect.map((value) => Option.fromNullishOr(value.sessions.get(id))),
      );
    },
  } as const;
});
