import * as NodePath from "node:path";

import {
  Data,
  Duration,
  Effect,
  FileSystem,
  Option,
  Schema,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import type * as vscode from "vscode";

import { MarimoClient } from "../lsp/MarimoClient.ts";
import { NotebookIdFromString } from "../schemas/Models.gen.ts";

const MAX_SAVED_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
const LOAD_TIMEOUT = Duration.seconds(10);
const FORCE_KILL_AFTER = Duration.seconds(1);

const ProbeResult = Schema.Struct({
  marimoVersion: Schema.String,
  cachePath: Schema.String,
});

class SavedSessionProbeError extends Data.TaggedError(
  "SavedSessionProbeError",
)<{
  readonly reason:
    | "exit"
    | "invalid-path"
    | "invalid-utf8"
    | "output-too-large"
    | "not-a-file"
    | "provenance";
}> {}

interface LoadSavedSessionOptions {
  readonly notebook: Pick<
    vscode.NotebookDocument,
    "isClosed" | "uri" | "version"
  >;
  readonly executable: string;
  readonly workingDirectory: string;
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

/**
 * Load outputs saved by marimo CLI for one local, ordinary Python notebook.
 *
 * The selected interpreter owns cache-location and version semantics. The
 * extension owns the bounded file read; the language server only receives
 * contents and validates them against its synchronized notebook snapshot.
 */
export const loadSavedSessionOutputs = Effect.fn("loadSavedSessionOutputs")(
  function* (options: LoadSavedSessionOptions) {
    const notebookUri = options.notebook.uri;
    const notebookVersion = options.notebook.version;
    if (
      options.notebook.isClosed ||
      notebookUri.scheme !== "file" ||
      !NodePath.isAbsolute(notebookUri.fsPath) ||
      NodePath.extname(notebookUri.fsPath).toLowerCase() !== ".py"
    ) {
      return Option.none();
    }

    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const marimo = yield* MarimoClient;
      const notebookId = yield* Schema.decodeUnknownEffect(
        NotebookIdFromString,
      )(notebookUri.toString());
      const notebookStat = yield* fs.stat(notebookUri.fsPath);
      if (notebookStat.type !== "File") {
        return yield* new SavedSessionProbeError({ reason: "not-a-file" });
      }
      yield* fs.access(notebookUri.fsPath, { readable: true });

      const probe = yield* runProbe(options);
      if (!NodePath.isAbsolute(probe.cachePath)) {
        return yield* new SavedSessionProbeError({ reason: "invalid-path" });
      }
      const stat = yield* fs.stat(probe.cachePath);
      if (stat.type !== "File" || stat.size > BigInt(MAX_SAVED_SESSION_BYTES)) {
        return yield* new SavedSessionProbeError({ reason: "not-a-file" });
      }

      const contents = yield* collectUtf8(
        fs.stream(probe.cachePath, {
          bytesToRead: MAX_SAVED_SESSION_BYTES + 1,
        }),
        MAX_SAVED_SESSION_BYTES,
      );
      if (
        options.notebook.isClosed ||
        options.notebook.version !== notebookVersion
      ) {
        return yield* new SavedSessionProbeError({ reason: "provenance" });
      }
      const decoded = yield* marimo.decodeSavedSession({
        notebookUri: notebookId,
        inner: {
          contents,
          marimoVersion: probe.marimoVersion,
          notebookVersion,
        },
      });
      if (
        decoded.marimoVersion !== probe.marimoVersion ||
        decoded.notebookVersion !== notebookVersion ||
        options.notebook.isClosed ||
        options.notebook.version !== notebookVersion
      ) {
        return yield* new SavedSessionProbeError({ reason: "provenance" });
      }
      return decoded;
    }).pipe(
      Effect.timeout(LOAD_TIMEOUT),
      Effect.tapCause((cause) =>
        Effect.logDebug("Saved session unavailable").pipe(
          Effect.annotateLogs({
            cause,
            notebookUri: notebookUri.toString(),
          }),
        ),
      ),
      Effect.option,
    );
  },
);

const runProbe = Effect.fnUntraced(function* (
  options: LoadSavedSessionOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const resultPath = yield* fs.makeTempFileScoped({
      prefix: "marimo-saved-session-probe-",
      suffix: ".json",
    });
    const command = ChildProcess.make(
      options.executable,
      ["-c", PROBE, options.notebook.uri.fsPath, resultPath],
      {
        cwd: options.workingDirectory,
        extendEnv: true,
        forceKillAfter: FORCE_KILL_AFTER,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const exitCode = yield* command.pipe(
      Effect.flatMap((handle) =>
        handle.exitCode.pipe(
          Effect.ensuring(
            handle
              .kill({ forceKillAfter: FORCE_KILL_AFTER })
              .pipe(
                Effect.andThen(handle.kill({ killSignal: "SIGKILL" })),
                Effect.ignore,
              ),
          ),
        ),
      ),
    );
    if (exitCode !== 0) {
      return yield* new SavedSessionProbeError({ reason: "exit" });
    }
    const stat = yield* fs.stat(resultPath);
    if (stat.type !== "File" || stat.size > BigInt(MAX_PROBE_OUTPUT_BYTES)) {
      return yield* new SavedSessionProbeError({ reason: "output-too-large" });
    }
    const result = yield* collectUtf8(
      fs.stream(resultPath, { bytesToRead: MAX_PROBE_OUTPUT_BYTES + 1 }),
      MAX_PROBE_OUTPUT_BYTES,
    );
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ProbeResult),
    )(result);
  }).pipe(Effect.scoped);
});

function collectUtf8<E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number,
) {
  return stream.pipe(
    Stream.runFoldEffect(
      () => ({
        decoder: new TextDecoder("utf-8", { fatal: true }),
        parts: [] as Array<string>,
        size: 0,
      }),
      (collected, chunk) => {
        const size = collected.size + chunk.length;
        if (size > limit) {
          return Effect.fail(
            new SavedSessionProbeError({ reason: "output-too-large" }),
          );
        }
        return Effect.try({
          try: () => {
            collected.parts.push(
              collected.decoder.decode(chunk, { stream: true }),
            );
            return { ...collected, size };
          },
          catch: () => new SavedSessionProbeError({ reason: "invalid-utf8" }),
        });
      },
    ),
    Effect.flatMap(({ decoder, parts }) => {
      return Effect.try({
        try: () => {
          parts.push(decoder.decode());
          return parts.join("");
        },
        catch: () => new SavedSessionProbeError({ reason: "invalid-utf8" }),
      });
    }),
  );
}
