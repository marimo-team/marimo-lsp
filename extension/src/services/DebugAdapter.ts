import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { Effect, HashMap, Option, Ref, Runtime, Schema, Stream } from "effect";

import {
  MarimoNotebookCell,
  type NotebookId,
  NotebookIdFromString,
} from "../schemas.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";
import { KernelManager } from "./KernelManager.ts";
import { createSourceMapping, MarimoDebugProxy } from "./MarimoDebugProxy.ts";
import { NotebookSerializer } from "./NotebookSerializer.ts";
import { OutputChannel } from "./OutputChannel.ts";
import { VsCode } from "./VsCode.ts";

const DEBUG_TYPE = "marimo";

/** Activation script injected into the kernel to start debugpy. */
function activationScript(debugpyLibsPath: string): string {
  return [
    "import sys as _sys, json as _json, tempfile as _tf, os as _os",
    `_sys.path.insert(0, ${JSON.stringify(debugpyLibsPath)})`,
    "import debugpy as _debugpy",
    '_host, _port = _debugpy.listen(("127.0.0.1", 0))',
    '_tmpdir = _os.path.join(_tf.gettempdir(), "marimo_" + str(_os.getpid()))',
    'print(_json.dumps({"port": _port, "tmpdir": _tmpdir}))',
  ].join("; ");
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

      const runtime = yield* Effect.runtime<VsCode>();
      const runFork = Runtime.runFork(runtime);

      const debugpyLibsPath = yield* resolveDebugpyPath(code);

      // Per-notebook debugpy state (activated once per kernel)
      const debugpyStates = yield* Ref.make(
        HashMap.empty<NotebookId, DebugpyState>(),
      );

      // Map from debug session ID -> notebookUri for cleanup
      const sessionNotebooks = yield* Ref.make(
        HashMap.empty<string, NotebookId>(),
      );

      yield* code.debug.onDidTerminateDebugSession((session) =>
        Ref.update(sessionNotebooks, HashMap.remove(session.id)),
      );

      yield* code.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
        createDebugAdapterDescriptor: Effect.fn(function* (session) {
          const config = Schema.decodeUnknownOption(MarimoDebugConfiguration)(
            session.configuration,
          );

          if (Option.isNone(config)) {
            yield* Effect.logWarning(
              "Debug session configuration did not match expected schema",
            ).pipe(
              Effect.annotateLogs({ configuration: session.configuration }),
            );
            return undefined;
          }

          const { notebookUri, cellIndex, cellMappings } = config.value.marimo;
          const state = HashMap.get(yield* Ref.get(debugpyStates), notebookUri);

          if (Option.isNone(state)) {
            return undefined;
          }

          yield* Ref.update(
            sessionNotebooks,
            HashMap.set(session.id, notebookUri),
          );

          const mapping = createSourceMapping(cellMappings);

          const proxy = new MarimoDebugProxy(
            "127.0.0.1",
            state.value.port,
            mapping,
            new code.EventEmitter(),
            () => {
              runFork(
                code.commands.executeCommand("notebook.cell.execute", {
                  ranges: [{ start: cellIndex, end: cellIndex + 1 }],
                }),
              );
            },
          );

          return new code.DebugAdapterInlineImplementation(proxy);
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
            yield* showErrorAndPromptLogs(
              "Cell has no stable ID. Run the cell first.",
            );
            return;
          }

          const notebookUri = cell.notebook.id;
          const cellIndex = cell.index;
          const cellDocumentUri = cell.document.uri.toString();
          const cellCode = cell.document.getText();

          // Activate debugpy in the kernel if not already done
          const existing = HashMap.get(
            yield* Ref.get(debugpyStates),
            notebookUri,
          );
          const state: DebugpyState = Option.isSome(existing)
            ? existing.value
            : yield* Effect.gen(function* () {
                yield* Effect.logInfo("Activating debugpy in kernel");
                const activated = yield* activateDebugpy(
                  kernelManager,
                  notebookUri,
                  debugpyLibsPath,
                );
                yield* Ref.update(
                  debugpyStates,
                  HashMap.set(notebookUri, activated),
                );
                yield* Effect.logInfo("debugpy activated").pipe(
                  Effect.annotateLogs({
                    port: activated.port,
                    tmpdir: activated.tmpdir,
                  }),
                );
                return activated;
              });

          // Build cell mappings: cellDocumentUri -> tmpdir/__marimo__cell_{cellId}_.py
          const cellFilePath = NodePath.join(
            state.tmpdir,
            `__marimo__cell_${cellId.value}_.py`,
          );
          const cellMappings: Record<string, string> = {
            [cellDocumentUri]: cellFilePath,
          };

          // Write cell source to disk so debugpy can find it for breakpoints.
          // The kernel's linecache has this content but debugpy needs real files.
          yield* Effect.try(() => {
            NodeFs.mkdirSync(NodePath.dirname(cellFilePath), {
              recursive: true,
            });
            NodeFs.writeFileSync(cellFilePath, cellCode, "utf-8");
          });

          yield* code.debug.startDebugging(undefined, {
            type: DEBUG_TYPE,
            request: "attach",
            name: "Debug Cell",
            justMyCode: true,
            rules: [{ include: cellFilePath }],
            marimo: {
              notebookUri,
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
