import * as NodePath from "node:path";

import { Data, Duration, Effect, FileSystem, Option, Schema } from "effect";
import { ChildProcess } from "effect/unstable/process";
import type * as vscode from "vscode";

import { MarimoClient } from "../lsp/MarimoClient.ts";
import { NotebookIdFromString } from "../schemas/Models.gen.ts";

const PROBE_TIMEOUT = Duration.seconds(10);
const FORCE_KILL_AFTER = Duration.seconds(1);

const ProbeResult = Schema.Struct({
  marimoVersion: Schema.String,
  cachePath: Schema.String,
});

class SavedSessionProbeError extends Data.TaggedError(
  "SavedSessionProbeError",
)<{
  readonly reason: "exit" | "invalid-path" | "not-a-file";
}> {}

export interface SelectedEnvironment {
  readonly executable: string;
  readonly arguments?: ReadonlyArray<string>;
  readonly workingDirectory: string;
}

interface ReadSessionOutputsOptions {
  readonly notebook: Pick<vscode.NotebookDocument, "isClosed" | "uri">;
  readonly environment?: SelectedEnvironment;
}

const PROBE = `\
import io, json, os, pathlib, sys

sys.stdout = io.StringIO()

import marimo
from marimo._session.state.serialize import get_session_cache_file

_cache_path = get_session_cache_file(pathlib.Path(sys.argv[1]))
_payload = {
    "marimoVersion": marimo.__version__,
    "cachePath": os.path.abspath(os.fspath(_cache_path)),
}

with open(sys.argv[2], "w", encoding="utf-8") as _result:
    json.dump(_payload, _result)
`;

/** Read marimo's replay notifications for an open notebook. */
export const readSessionOutputs = Effect.fn("readSessionOutputs")(function* (
  options: ReadSessionOutputsOptions,
) {
  if (options.notebook.isClosed) {
    return [];
  }

  const marimo = yield* MarimoClient;
  const notebookId = yield* Schema.decodeUnknownEffect(NotebookIdFromString)(
    options.notebook.uri.toString(),
  );
  const location = yield* locateSavedSession(options).pipe(
    Effect.tapCause((cause) =>
      Effect.logDebug("Saved session location unavailable").pipe(
        Effect.annotateLogs({
          cause,
          notebookUri: options.notebook.uri.toString(),
        }),
      ),
    ),
    Effect.option,
    Effect.map(Option.flatten),
    Effect.map(Option.getOrNull),
  );

  if (options.notebook.isClosed) {
    return [];
  }
  const response = yield* marimo.readSessionOutputs({
    notebookUri: notebookId,
    inner: { location },
  });
  if (options.notebook.isClosed) {
    return [];
  }

  return response.notifications;
});

const locateSavedSession = Effect.fnUntraced(function* (
  options: ReadSessionOutputsOptions,
) {
  const environment = options.environment;
  const notebookUri = options.notebook.uri;
  if (
    environment === undefined ||
    notebookUri.scheme !== "file" ||
    !NodePath.isAbsolute(notebookUri.fsPath) ||
    NodePath.extname(notebookUri.fsPath).toLowerCase() !== ".py"
  ) {
    return Option.none();
  }

  const fs = yield* FileSystem.FileSystem;
  const result = yield* Effect.gen(function* () {
    const notebookStat = yield* fs.stat(notebookUri.fsPath);
    if (notebookStat.type !== "File") {
      return yield* new SavedSessionProbeError({ reason: "not-a-file" });
    }
    yield* fs.access(notebookUri.fsPath, { readable: true });

    const resultPath = yield* fs.makeTempFileScoped({
      prefix: "marimo-saved-session-probe-",
      suffix: ".json",
    });
    const command = ChildProcess.make(
      environment.executable,
      [
        ...(environment.arguments ?? []),
        "-c",
        PROBE,
        notebookUri.fsPath,
        resultPath,
      ],
      {
        cwd: environment.workingDirectory,
        extendEnv: true,
        forceKillAfter: FORCE_KILL_AFTER,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const exitCode = yield* command.pipe(
      Effect.flatMap((handle) => handle.exitCode),
    );
    if (exitCode !== 0) {
      return yield* new SavedSessionProbeError({ reason: "exit" });
    }

    const probe = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ProbeResult),
    )(yield* fs.readFileString(resultPath));
    if (!NodePath.isAbsolute(probe.cachePath)) {
      return yield* new SavedSessionProbeError({ reason: "invalid-path" });
    }
    return probe;
  }).pipe(Effect.scoped, Effect.timeout(PROBE_TIMEOUT));

  return Option.some(result);
});
