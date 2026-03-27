import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { Effect, HashMap, Option, Ref, Schema, Stream } from "effect";

import {
  MarimoNotebookCell,
  type NotebookId,
  NotebookIdFromString,
} from "../schemas.ts";
import { createSourceMapping, makeDapProxy } from "../utils/dap-proxy.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";
import { KernelManager } from "./KernelManager.ts";
import { NotebookSerializer } from "./NotebookSerializer.ts";
import { OutputChannel } from "./OutputChannel.ts";
import { VsCode } from "./VsCode.ts";

const DEBUG_TYPE = "marimo";

/** Activation script injected into the kernel to start debugpy. */
function activationScript(debugpyLibsPath: string): string {
  // Idempotent: stores the port in a global so subsequent calls
  // skip `debugpy.listen()` and just report the cached port.
  return `
import sys as _sys, json as _json, tempfile as _tf, os as _os
if not hasattr(_sys, "_marimo_debugpy_port"):
    _sys.path.insert(0, ${JSON.stringify(debugpyLibsPath)})
    import debugpy as _debugpy
    _, _sys._marimo_debugpy_port = _debugpy.listen(("127.0.0.1", 0))
_tmpdir = _os.path.join(_tf.gettempdir(), "marimo_" + str(_os.getpid()))
print(_json.dumps({"port": _sys._marimo_debugpy_port, "tmpdir": _tmpdir}))
`.trim();
}

/** Resolve the bundled debugpy libs path from the ms-python.debugpy extension. */
const resolveDebugpyPath = Effect.fn(function* (code: VsCode) {
  const ext = code.extensions.getExtension("ms-python.debugpy");
  if (Option.isNone(ext)) {
    yield* Effect.logWarning("ms-python.debugpy extension not found");
    return "";
  }
  return NodePath.join(ext.value.extensionPath, "bundled", "libs");
});

type DebugpyState = typeof DebugpyState.Type;
const DebugpyState = Schema.Struct({
  port: Schema.Number,
  tmpdir: Schema.String,
});

/** Schema for the debug configuration passed through `startDebugging`. */
const MarimoDebugConfiguration = Schema.Struct({
  type: Schema.Literal(DEBUG_TYPE),
  request: Schema.Literal("attach"),
  name: Schema.String,
  justMyCode: Schema.Boolean,
  marimo: Schema.Struct({
    notebookUri: NotebookIdFromString,
    port: Schema.Number,
    cellIndex: Schema.Number,
    cellMappings: Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  }),
});

/**
 * Provides Debug Adapter Protocol (DAP) bridge for marimo notebooks.
 *
 * Activates debugpy on-demand inside the kernel subprocess and creates
 * an inline debug adapter that proxies DAP messages between VS Code
 * and debugpy, rewriting source paths so that notebook cell URIs map
 * to the temp file paths debugpy knows about.
 */
export class DebugAdapter extends Effect.Service<DebugAdapter>()(
  "DebugAdapter",
  {
    dependencies: [NotebookSerializer.Default, OutputChannel.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const kernelManager = yield* KernelManager;

      const debugpyLibsPath = yield* resolveDebugpyPath(code);

      // Map from notebookUri -> debug session ID for lifecycle management
      const activeSessions = yield* Ref.make(
        HashMap.empty<NotebookId, string>(),
      );

      yield* code.debug.onDidTerminateDebugSession((session) =>
        Effect.gen(function* () {
          const sessions = yield* Ref.get(activeSessions);
          const entry = HashMap.findFirst(sessions, (id) => id === session.id);

          if (Option.isSome(entry)) {
            yield* Ref.update(activeSessions, HashMap.remove(entry.value[0]));
            yield* Effect.logInfo("Debug session ended").pipe(
              Effect.annotateLogs({
                sessionId: session.id,
                notebookUri: entry.value[0],
              }),
            );
          }
        }),
      );

      yield* code.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
        createDebugAdapter: Effect.fn(function* (session) {
          const config = Schema.decodeUnknownOption(MarimoDebugConfiguration)(
            session.configuration,
          );

          if (Option.isNone(config)) {
            yield* Effect.logWarning(
              "Debug session configuration did not match expected schema",
            ).pipe(
              Effect.annotateLogs({ configuration: session.configuration }),
            );
            return Option.none();
          }

          const { notebookUri, port, cellIndex, cellMappings } =
            config.value.marimo;

          yield* Ref.update(
            activeSessions,
            HashMap.set(notebookUri, session.id),
          );

          const mapping = createSourceMapping(cellMappings);

          const proxy = yield* makeDapProxy("127.0.0.1", port, mapping);

          yield* proxy.ready.pipe(
            Effect.andThen(
              code.commands.executeCommand("notebook.cell.execute", {
                ranges: [{ start: cellIndex, end: cellIndex + 1 }],
              }),
            ),
            Effect.forkScoped,
          );

          return Option.some(proxy.adapter);
        }),
      });

      yield* code.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
        resolveDebugConfiguration(_folder, config) {
          // Config is pre-filled by debugCell(); just pass through
          if (config.type === DEBUG_TYPE) {
            return config;
          }
          return undefined;
        },
      });

      return {
        debugCell: Effect.fn("DebugAdapter.debugCell")(function* (
          cell: MarimoNotebookCell,
        ) {
          if (!debugpyLibsPath) {
            yield* showErrorAndPromptLogs(
              "Cannot debug: ms-python.debugpy extension is not installed.",
            );
            return;
          }

          const cellId = cell.id;
          if (Option.isNone(cellId)) {
            yield* code.window.showWarningMessage(
              "No notebook kernel is running. Run a cell first to start the kernel.",
            );
            return;
          }

          const notebook = cell.notebook;
          const notebookUri = notebook.id;

          // Stop any existing debug session for this notebook
          const existingSessionId = HashMap.get(
            yield* Ref.get(activeSessions),
            notebookUri,
          );
          if (Option.isSome(existingSessionId)) {
            yield* Effect.logInfo("Stopping existing debug session");
            yield* code.debug.stopDebugging(existingSessionId.value);
          }
          const cellIndex = cell.index;
          const allCells = notebook.getCells();

          // Activate debugpy (idempotent — returns existing port if already running)
          yield* Effect.logInfo("Activating debugpy in kernel");
          const state = yield* activateDebugpy(
            kernelManager,
            notebookUri,
            debugpyLibsPath,
          );
          yield* Effect.logInfo("debugpy ready").pipe(
            Effect.annotateLogs({
              port: state.port,
              tmpdir: state.tmpdir,
            }),
          );

          // Build mappings for ALL cells so stepping across cells works.
          // Each cell URI maps to its temp file path on disk.
          const cellMappings: Record<string, string> = {};
          yield* Effect.try(() => {
            NodeFs.mkdirSync(state.tmpdir, { recursive: true });
            for (const c of allCells) {
              const id = c.id;
              if (Option.isNone(id)) continue;
              const filePath = NodePath.join(
                state.tmpdir,
                `__marimo__cell_${id.value}_.py`,
              );
              cellMappings[c.document.uri.toString()] = filePath;
              NodeFs.writeFileSync(filePath, c.document.getText(), "utf-8");
            }
          }).pipe(
            Effect.tapError((error) =>
              Effect.logError("Failed to write cell files to disk").pipe(
                Effect.annotateLogs({
                  error: String(error),
                  tmpdir: state.tmpdir,
                }),
              ),
            ),
          );

          yield* code.debug.startDebugging(undefined, {
            type: DEBUG_TYPE,
            request: "attach",
            name: "Debug Cell",
            justMyCode: false,
            marimo: {
              notebookUri,
              port: state.port,
              cellIndex,
              cellMappings,
            },
          });
        }),
      };
    }),
  },
) {}

/**
 * Activate debugpy in the kernel by running a scratchpad snippet
 * and parsing the port + tmpdir from stdout.
 */
function activateDebugpy(
  kernelManager: KernelManager,
  notebookUri: NotebookId,
  debugpyLibsPath: string,
) {
  return Effect.gen(function* () {
    const script = activationScript(debugpyLibsPath);
    const ops = kernelManager.executeCodeUnsafe(notebookUri, script);

    // Collect all console outputs and find the JSON with port + tmpdir
    let result: DebugpyState | undefined;

    yield* Stream.runForEach(ops, (op) =>
      Effect.sync(() => {
        if (result) return;
        const consoleOutput = (op as Record<string, unknown>).console;
        if (!consoleOutput) return;

        const outputs = Array.isArray(consoleOutput)
          ? consoleOutput
          : [consoleOutput];
        for (const output of outputs) {
          const out = output as Record<string, unknown>;
          if (out.channel === "stdout" && typeof out.data === "string") {
            try {
              const json: unknown = JSON.parse(out.data.trim());
              const decoded = Schema.decodeUnknownOption(DebugpyState)(json);
              if (Option.isSome(decoded)) {
                result = decoded.value;
              }
            } catch {
              // Not valid JSON, skip
            }
          }
        }
      }),
    );

    if (!result) {
      return yield* Effect.fail(
        new Error("Failed to activate debugpy: no port received"),
      );
    }

    return result;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        yield* Effect.logError("debugpy activation failed").pipe(
          Effect.annotateLogs({ error: String(error) }),
        );
        return yield* Effect.die(error);
      }),
    ),
  );
}
