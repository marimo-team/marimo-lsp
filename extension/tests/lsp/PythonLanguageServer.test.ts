import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Vitest from "@effect/vitest";
import { Context, Effect, Layer, Option, Schedule } from "effect";

import * as PythonLanguageServer from "../../src/lsp/PythonLanguageServer.ts";
import * as ExtensionContext from "../../src/platform/ExtensionContext.ts";
import * as Storage from "../../src/platform/Storage.ts";
import { Memento } from "../fake/ExtensionContext.ts";
import * as PythonExtensionTest from "../fake/PythonExtension.ts";
import * as TelemetryTest from "../fake/Telemetry.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const DISMISSED_KEY = "languageServer.ty.installPromptDismissed";
const REPLAY_ENV = "MARIMO_REPLAY_TY_PROMPT";

class RecordingMemento extends Memento {
  writes = 0;

  override async update(key: string, value: unknown) {
    this.writes += 1;
    await super.update(key, value);
  }
}

/** The persisted global state backing Storage for one test. */
class GlobalState extends Context.Service<GlobalState, RecordingMemento>()(
  "@marimo/test/PythonLanguageServer/GlobalState",
) {}

interface Options {
  readonly installed?: boolean;
  readonly replayDismissal?: boolean;
  readonly failInstall?: boolean;
}

const layerWith = (options: Options = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (options.replayDismissal) {
        const previous = process.env[REPLAY_ENV];
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env[REPLAY_ENV] = "1";
          }),
          () =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env[REPLAY_ENV];
              else process.env[REPLAY_ENV] = previous;
            }),
        );
      }

      const globalState = new RecordingMemento();
      if (options.replayDismissal) {
        yield* Effect.promise(() => globalState.update(DISMISSED_KEY, true));
        globalState.writes = 0;
      }
      const contextLayer = Layer.succeed(ExtensionContext.Service, {
        globalState,
        workspaceState: new Memento(),
        extensionUri: VsCodeTest.Uri.parse("file:///test/extension/path", true),
        globalStorageUri: VsCodeTest.Uri.parse(
          "file://test/extension/libs",
          true,
        ),
      });

      return Layer.mergeAll(
        VsCodeTest.layerWith({
          installedExtensions: options.installed ? ["astral-sh.ty"] : [],
          rejectedCommands: options.failInstall
            ? ["workbench.extensions.installExtension"]
            : [],
        }),
        Storage.layer.pipe(Layer.provide(contextLayer)),
        TelemetryTest.layer,
        Layer.succeed(GlobalState, globalState),
      );
    }),
  );

/**
 * Runs a fresh notifier `times` times, as one new session would. The notifier
 * is cached per session, so calls after the first exercise the suppression path.
 */
const notifyInNewSession = Effect.fn("notifyInNewSession")(function* (
  times = 1,
) {
  const notify = yield* PythonLanguageServer.makeMissingNotifier();
  yield* Effect.forEach(Array.from({ length: times }), () => notify, {
    discard: true,
  });
});

const telemetry = Effect.flatMap(
  TelemetryTest.Service,
  (telemetry) => telemetry.tySetupActions,
);

const storage = Effect.map(GlobalState, (state) => state.toJSON());

Vitest.describe("PythonLanguageServer", () => {
  Vitest.it(
    "points at both extensions and path settings when no binary is found",
    () => {
      const error = new PythonLanguageServer.BinaryNotFoundError({
        tyVersion: "0.0.63",
        pyreflyVersion: "1.0.0",
      });

      Vitest.expect(error.format()).toBe(
        [
          "No compatible binary was found for ty (0.0.63 or newer) or Pyrefly (1.0.0 or newer).",
          "Python completions and type diagnostics are unavailable. You can still edit and run notebooks.",
          "To enable these features, install or update the official ty extension (astral-sh.ty) or Pyrefly extension (meta.pyrefly), or set marimo.ty.path or marimo.pyrefly.path, then reload VS Code.",
        ].join("\n"),
      );
    },
  );

  Vitest.describe("when the prompt is ignored", () => {
    const it = EffectTest.make(layerWith());

    it.effect(
      "warns about unavailable Python language features at most once per session",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        const notify = yield* PythonLanguageServer.makeMissingNotifier();
        yield* Effect.all([notify, notify], { concurrency: "unbounded" });

        Vitest.expect((yield* vscode.snapshot).warningMessages).toEqual([
          "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Install the recommended ty extension to enable them. You can still edit and run notebooks.",
        ]);
      }),
    );
  });

  Vitest.describe("when the prompt is permanently dismissed", () => {
    const it = EffectTest.make(layerWith());

    it.effect(
      "never prompts again once the user dismisses it",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        yield* vscode.selectWarningMessage("Don't Show Again");
        const notify = yield* PythonLanguageServer.makeMissingNotifier();
        yield* notify;
        yield* notifyInNewSession();

        Vitest.expect((yield* vscode.snapshot).warningMessages).toHaveLength(1);
        Vitest.expect(yield* storage).toEqual({
          "languageServer.ty.installPromptDismissed": true,
        });
        Vitest.expect(yield* telemetry).toEqual([
          "prompt_shown",
          "dont_show_again",
          "prompt_suppressed",
        ]);
      }),
    );
  });

  Vitest.describe("when replaying the prompt during local development", () => {
    const it = EffectTest.make(layerWith({ replayDismissal: true }));

    it.effect(
      "replays saved dismissals without writing state during local development",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        const state = yield* GlobalState;
        yield* vscode.selectWarningMessage("Don't Show Again");
        yield* vscode.selectWarningMessage("Don't Show Again");
        const notify = yield* PythonLanguageServer.makeMissingNotifier();
        yield* notify;
        yield* notify;
        yield* notifyInNewSession(2);

        Vitest.expect((yield* vscode.snapshot).warningMessages).toHaveLength(2);
        Vitest.expect(state.writes).toBe(0);
        Vitest.expect(yield* storage).toEqual({
          "languageServer.ty.installPromptDismissed": true,
        });
      }),
    );
  });

  Vitest.describe("when installing the companion extension", () => {
    const it = EffectTest.make(layerWith());

    it.effect(
      "installs the companion extension and reloads when selected",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        yield* vscode.selectWarningMessage("Install ty Extension");
        yield* vscode.selectInformationMessage("Reload Window");
        yield* yield* PythonLanguageServer.makeMissingNotifier();

        Vitest.expect(yield* storage).toEqual({});
        Vitest.expect(yield* telemetry).toEqual([
          "prompt_shown",
          "install",
          "install_succeeded",
        ]);
        Vitest.expect((yield* vscode.snapshot).executions).toEqual([
          {
            command: "workbench.extensions.installExtension",
            args: ["astral-sh.ty"],
          },
          { command: "workbench.action.reloadWindow", args: [] },
        ]);
      }),
    );
  });

  Vitest.describe("when the companion extension is already installed", () => {
    const it = EffectTest.make(layerWith({ installed: true }));

    it.effect(
      "asks an existing ty extension to be updated instead of installed",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        yield* vscode.selectWarningMessage("Show ty Extension");
        yield* vscode.selectWarningMessage("Show ty Extension");
        yield* yield* PythonLanguageServer.makeMissingNotifier();
        yield* notifyInNewSession();

        const snapshot = yield* vscode.snapshot;
        Vitest.expect(snapshot.warningMessages).toEqual([
          "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Update the ty extension to enable them. You can still edit and run notebooks.",
          "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Update the ty extension to enable them. You can still edit and run notebooks.",
        ]);
        Vitest.expect(snapshot.executions).toEqual([
          { command: "extension.open", args: ["astral-sh.ty"] },
          { command: "extension.open", args: ["astral-sh.ty"] },
        ]);
        Vitest.expect(yield* storage).toEqual({});
      }),
    );
  });

  Vitest.describe("when installation fails", () => {
    const it = EffectTest.make(layerWith({ failInstall: true }));

    it.effect(
      "reports a companion extension installation failure without prompting to reload",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        yield* vscode.selectWarningMessage("Install ty Extension");
        yield* yield* PythonLanguageServer.makeMissingNotifier();

        const snapshot = yield* vscode.snapshot;
        Vitest.expect(snapshot.executions).toEqual([
          {
            command: "workbench.extensions.installExtension",
            args: ["astral-sh.ty"],
          },
        ]);
        Vitest.expect(yield* telemetry).toEqual([
          "prompt_shown",
          "install",
          "install_failed",
        ]);
        Vitest.expect(snapshot.informationMessages).toEqual([]);
        Vitest.expect(snapshot.errorMessages).toEqual([
          "VS Code couldn't install the ty extension. Search for @id:astral-sh.ty in the Extensions view.",
        ]);
      }),
    );
  });
});

/** Bundled binary versions of the companion extensions to install. */
interface Installed {
  readonly ty?: string;
  readonly pyrefly?: string;
  readonly configuredPyrefly?: string;
}

/** The folder that holds the fake extensions for one test. */
class FakeExtensions extends Context.Service<
  FakeExtensions,
  { readonly root: string }
>()("@marimo/test/PythonLanguageServer/FakeExtensions") {}

/**
 * A stand-in language server. It answers `--version`, records its name and
 * arguments in a `started` file on each start, and answers the initialize and
 * shutdown requests so that the server reaches the running state.
 */
const FAKE_SERVER = `
const NodeFs = require("node:fs");
const [name, version, started] = JSON.parse(process.env.FAKE_SERVER_ARGS);
if (process.argv[2] === "--version") {
  console.log(name + " " + version);
  process.exit(0);
}
NodeFs.appendFileSync(started, [name, ...process.argv.slice(2)].join(" ") + "\\n");
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
};
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === "initialize") {
      send({ id: message.id, result: { capabilities: {}, serverInfo: { name, version } } });
    } else if (message.method === "shutdown") {
      send({ id: message.id, result: null });
    } else if (message.method === "exit") {
      process.exit(0);
    }
  }
});
`;

function writeFakeExtension(
  root: string,
  name: "ty" | "pyrefly",
  binaryDir: ReadonlyArray<string>,
  version: string,
): string {
  const extensionPath = NodePath.join(root, name);
  const directory = NodePath.join(extensionPath, ...binaryDir);
  NodeFs.mkdirSync(directory, { recursive: true });
  const script = NodePath.join(directory, `${name}.cjs`);
  NodeFs.writeFileSync(script, FAKE_SERVER);
  const args = JSON.stringify([name, version, NodePath.join(root, "started")]);
  NodeFs.writeFileSync(
    NodePath.join(directory, name),
    [
      "#!/bin/sh",
      `FAKE_SERVER_ARGS='${args}' exec "${process.execPath}" "${script}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return extensionPath;
}

const selectionLayerWith = (installed: Installed) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeFs.mkdtempDisposableSync(
            NodePath.join(NodeOs.tmpdir(), "marimo-lsp-"),
          ),
        ),
        (disposable) => Effect.sync(() => disposable.remove()),
      );
      const extensionPaths: Record<string, string> = {};
      if (installed.ty !== undefined) {
        extensionPaths["astral-sh.ty"] = writeFakeExtension(
          root.path,
          "ty",
          ["bundled", "libs", "bin"],
          installed.ty,
        );
      }
      if (installed.pyrefly !== undefined) {
        extensionPaths["meta.pyrefly"] = writeFakeExtension(
          root.path,
          "pyrefly",
          ["bin"],
          installed.pyrefly,
        );
      }
      if (installed.configuredPyrefly !== undefined) {
        writeFakeExtension(
          root.path,
          "pyrefly",
          ["custom"],
          installed.configuredPyrefly,
        );
      }
      const contextLayer = Layer.succeed(ExtensionContext.Service, {
        globalState: new Memento(),
        workspaceState: new Memento(),
        extensionUri: VsCodeTest.Uri.parse("file:///test/extension/path", true),
        globalStorageUri: VsCodeTest.Uri.parse(
          "file://test/extension/libs",
          true,
        ),
      });

      return PythonLanguageServer.defaultLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            VsCodeTest.layerWith(
              {
                installedExtensions: Object.keys(extensionPaths),
                extensionPaths,
              },
              installed.configuredPyrefly === undefined
                ? {}
                : {
                    workspace: {
                      getWorkspaceFolders: Effect.succeed(
                        Option.some([
                          {
                            uri: VsCodeTest.Uri.file(root.path),
                            name: "workspace",
                            index: 0,
                          },
                        ]),
                      ),
                      getConfiguration: (section) =>
                        Effect.succeed({
                          // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
                          get: <T>(key: string) => {
                            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                            return (
                              section === "pyrefly" && key === "lspPath"
                                ? "./pyrefly/custom/pyrefly"
                                : undefined
                            ) as T;
                          },
                          has: () => false,
                          inspect: () => undefined,
                          async update() {},
                        }),
                    },
                  },
            ),
            PythonExtensionTest.layer,
            TelemetryTest.layer,
            contextLayer,
            Layer.succeed(FakeExtensions, { root: root.path }),
          ),
        ),
      );
    }),
  );

const poll = Schedule.spaced("10 millis");

/** The first server command line that a fake binary recorded. */
const startedServer = Effect.gen(function* () {
  yield* PythonLanguageServer.Service;
  const { root } = yield* FakeExtensions;
  const started = NodePath.join(root, "started");
  return yield* Effect.sync(() =>
    NodeFs.existsSync(started) ? NodeFs.readFileSync(started, "utf8") : "",
  ).pipe(
    Effect.repeat({ until: (contents) => contents !== "", schedule: poll }),
    Effect.map((contents) => contents.trim()),
    Effect.timeout("4 seconds"),
  );
});

// Skipped on Windows: the stand-in binaries are shell scripts.
Vitest.describe.skipIf(process.platform === "win32")("server selection", () => {
  Vitest.describe(
    "when Pyrefly has a workspace-relative configured path",
    () => {
      const it = EffectTest.make(
        selectionLayerWith({ pyrefly: "1.4.0", configuredPyrefly: "1.5.0" }),
      );

      it.live(
        "starts the configured executable instead of the bundled one",
        Effect.fn(function* () {
          Vitest.expect(yield* runningServer).toBe("pyrefly");
          const server = yield* PythonLanguageServer.Service;
          const { root } = yield* FakeExtensions;
          Vitest.expect(yield* server.getHealthStatus).toMatchObject({
            _tag: "Running",
            serverVersion: "1.5.0",
            binarySource: {
              kind: "configured",
              path: NodePath.join(root, "pyrefly/custom/pyrefly"),
            },
          });
        }),
      );
    },
  );

  Vitest.describe("when ty and Pyrefly are both installed", () => {
    const it = EffectTest.make(
      selectionLayerWith({ ty: "0.0.63", pyrefly: "1.4.0" }),
    );

    it.live(
      "starts ty",
      Effect.fn(function* () {
        Vitest.expect(yield* startedServer).toBe("ty server");
      }),
    );
  });

  Vitest.describe("when only Pyrefly is installed", () => {
    const it = EffectTest.make(selectionLayerWith({ pyrefly: "1.4.0" }));

    it.live(
      "starts Pyrefly from the extension's bin folder",
      Effect.fn(function* () {
        Vitest.expect(yield* startedServer).toBe("pyrefly lsp");
      }),
    );
  });

  Vitest.describe("when the installed ty is too old", () => {
    const it = EffectTest.make(
      selectionLayerWith({ ty: "0.0.1", pyrefly: "1.4.0" }),
    );

    it.live(
      "falls back to Pyrefly",
      Effect.fn(function* () {
        Vitest.expect(yield* startedServer).toBe("pyrefly lsp");
      }),
    );
  });

  Vitest.describe("when the installed Pyrefly is too old", () => {
    const it = EffectTest.make(selectionLayerWith({ pyrefly: "0.64.0" }));

    it.live(
      "asks the user to install ty",
      Effect.fn(function* () {
        const server = yield* PythonLanguageServer.Service;
        const vscode = yield* VsCodeTest.Service;
        const status = yield* server.getHealthStatus.pipe(
          Effect.repeat({
            until: (status) => status._tag !== "Starting",
            schedule: poll,
          }),
          Effect.timeout("4 seconds"),
        );

        Vitest.expect(status._tag).toBe("NotFound");
        Vitest.expect((yield* vscode.snapshot).warningMessages).toEqual([
          "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Install the recommended ty extension to enable them. You can still edit and run notebooks.",
        ]);
      }),
    );
  });
});

/** How many times a fake binary has been started as a server. */
const startCount = Effect.gen(function* () {
  const { root } = yield* FakeExtensions;
  const started = NodePath.join(root, "started");
  return yield* Effect.sync(() =>
    NodeFs.existsSync(started)
      ? NodeFs.readFileSync(started, "utf8").trim().split("\n").length
      : 0,
  );
});

/** Waits until the server is running, returning its name. */
const runningServer = Effect.gen(function* () {
  const server = yield* PythonLanguageServer.Service;
  const status = yield* server.getHealthStatus.pipe(
    Effect.repeat({
      until: (status) => status._tag === "Running",
      schedule: poll,
    }),
    Effect.timeout("4 seconds"),
  );
  return status._tag === "Running" ? status.server : undefined;
});

/** Fires a configuration change event for one changed setting. */
const changeSetting = (key: string) =>
  Effect.flatMap(VsCodeTest.Service, (vscode) =>
    vscode.configurationChange({
      affectsConfiguration: (section) =>
        key === section || key.startsWith(`${section}.`),
    }),
  );

Vitest.describe.skipIf(process.platform === "win32")("restarts", () => {
  Vitest.describe("when Pyrefly is running", () => {
    const it = EffectTest.make(selectionLayerWith({ pyrefly: "1.4.0" }));

    it.live(
      "restarts Pyrefly when a setting it reads changes",
      Effect.fn(function* () {
        Vitest.expect(yield* runningServer).toBe("pyrefly");
        // The server subscribes to changes after it reports running, so
        // keep firing until a restart shows up.
        yield* changeSetting("python.pyrefly.displayTypeErrors").pipe(
          Effect.andThen(startCount),
          Effect.repeat({ until: (count) => count >= 2, schedule: poll }),
          Effect.timeout("4 seconds"),
        );
      }),
    );

    it.live(
      "keeps Pyrefly running when an unrelated setting changes",
      Effect.fn(function* () {
        Vitest.expect(yield* runningServer).toBe("pyrefly");
        yield* Effect.sleep("200 millis");
        yield* changeSetting("editor.fontSize");
        yield* Effect.sleep("300 millis");
        Vitest.expect(yield* startCount).toBe(1);
      }),
    );
  });

  Vitest.describe("when ty is running", () => {
    const it = EffectTest.make(
      selectionLayerWith({ ty: "0.0.63", pyrefly: "1.4.0" }),
    );

    it.live(
      "keeps ty running when a Pyrefly setting changes",
      Effect.fn(function* () {
        Vitest.expect(yield* runningServer).toBe("ty");
        yield* Effect.sleep("200 millis");
        yield* changeSetting("python.pyrefly.displayTypeErrors");
        yield* Effect.sleep("300 millis");
        Vitest.expect(yield* startCount).toBe(1);
      }),
    );
  });
});
