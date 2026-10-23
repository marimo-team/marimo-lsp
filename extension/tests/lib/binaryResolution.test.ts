import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Vitest from "@effect/vitest";
import { Context, Effect, Layer, Logger, Option, References } from "effect";
import { vi } from "vite-plus/test";

import {
  BinarySource,
  type ResolutionSource,
  type ServerBinary,
  resolveServerBinary,
  parseVersionOutput,
  resolveBinary,
} from "../../src/lib/binaryResolution.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

vi.mock("node:child_process", { spy: true });

Vitest.describe("parseVersionOutput", () => {
  Vitest.it("parses ruff version output", () => {
    Vitest.expect(parseVersionOutput("ruff 0.15.0")).toBe("0.15.0");
  });

  Vitest.it("parses ty version output", () => {
    Vitest.expect(parseVersionOutput("ty 0.0.15")).toBe("0.0.15");
  });

  Vitest.it("handles version with prerelease info", () => {
    Vitest.expect(parseVersionOutput("ruff 0.15.0-dev")).toBe("0.15.0-dev");
  });

  Vitest.it("handles trailing whitespace/newlines", () => {
    Vitest.expect(parseVersionOutput("ruff 0.15.0\n")).toBe("0.15.0");
  });

  Vitest.it("returns null for empty output", () => {
    Vitest.expect(parseVersionOutput("")).toBeNull();
  });

  Vitest.it("returns null for malformed output", () => {
    Vitest.expect(parseVersionOutput("not a version")).toBeNull();
  });

  Vitest.it("returns null for output without version number", () => {
    Vitest.expect(parseVersionOutput("ruff")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveBinary
// ---------------------------------------------------------------------------

/** Source that resolves to a UserConfigured variant. */
function userSource(path: string): ResolutionSource {
  return {
    label: "user",
    resolve: Effect.succeed(Option.some(BinarySource.UserConfigured({ path }))),
  };
}

/** Source that resolves to a CompanionExtension variant. */
function companionSource(
  path: string,
  kind: "configured" | "bundled" = "bundled",
): ResolutionSource {
  return {
    label: "companion",
    resolve: Effect.succeed(
      Option.some(
        BinarySource.CompanionExtension({
          extensionId: "test.ext",
          path,
          kind,
        }),
      ),
    ),
  };
}

/** Source that resolves to none. */
function emptySource(label: string): ResolutionSource {
  return { label, resolve: Effect.succeed(Option.none()) };
}

Vitest.describe("resolveBinary", () => {
  Vitest.it.effect(
    "returns the first source that resolves",
    Effect.fn(function* () {
      const result = yield* resolveBinary("test", [
        userSource("/first"),
        companionSource("/second"),
      ]);
      Vitest.expect(result).toStrictEqual(
        Option.some(BinarySource.UserConfigured({ path: "/first" })),
      );
    }),
  );

  Vitest.it.effect(
    "skips empty sources and returns the next match",
    Effect.fn(function* () {
      const result = yield* resolveBinary("test", [
        emptySource("skip"),
        companionSource("/good", "configured"),
      ]);
      Vitest.expect(result).toStrictEqual(
        Option.some(
          BinarySource.CompanionExtension({
            extensionId: "test.ext",
            path: "/good",
            kind: "configured",
          }),
        ),
      );
    }),
  );

  Vitest.it.effect(
    "returns none when every source is empty",
    Effect.fn(function* () {
      const result = yield* resolveBinary("test", [
        emptySource("a"),
        emptySource("b"),
      ]);
      Vitest.expect(result).toStrictEqual(Option.none());
    }),
  );

  Vitest.it.effect(
    "returns none when there are no sources at all",
    Effect.fn(function* () {
      const sources: ReadonlyArray<ResolutionSource> = [];
      Vitest.expect(yield* resolveBinary("test", sources)).toStrictEqual(
        Option.none(),
      );
    }),
  );

  Vitest.it.effect(
    "preserves CompanionExtension kind=bundled",
    Effect.fn(function* () {
      const result = yield* resolveBinary("ruff", [
        emptySource("user"),
        companionSource("/ext/bundled/libs/bin/ruff", "bundled"),
      ]);
      Vitest.expect(
        Option.map(result, (source) =>
          BinarySource.$is("CompanionExtension")(source) ? source.kind : null,
        ),
      ).toStrictEqual(Option.some("bundled"));
    }),
  );

  Vitest.it.effect(
    "emits structured logs with server and source annotations",
    Effect.fn(function* () {
      const logs = yield* collectLogs(
        resolveBinary("ty", [emptySource("tier-1"), userSource("/bin/ty")]),
      );

      const serverAnnotated = logs.filter((l) => l.annotations.server === "ty");
      Vitest.expect(serverAnnotated.length).toBeGreaterThan(0);

      const resolved = logs.find((l) => l.message.includes("Resolved"));
      Vitest.expect(resolved).toMatchObject({
        annotations: { source: "UserConfigured", path: "/bin/ty" },
      });
    }),
  );

  Vitest.it.effect(
    "logs every source it tried when nothing resolves",
    Effect.fn(function* () {
      const logs = yield* collectLogs(
        resolveBinary("ty", [emptySource("tier-1"), emptySource("tier-2")]),
      );

      const unresolved = logs.find((l) =>
        l.message.includes("No source resolved a binary"),
      );
      Vitest.expect(unresolved).toMatchObject({
        annotations: { server: "ty", sources: ["tier-1", "tier-2"] },
      });
    }),
  );
});

/** Runs `effect` at debug level, capturing every log line it emits. */
function collectLogs(effect: Effect.Effect<unknown>) {
  const logs: Array<{
    message: string;
    annotations: Record<string, unknown>;
  }> = [];
  return effect.pipe(
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.provide(
      Logger.layer([
        Logger.make(({ message, fiber }) => {
          logs.push({
            message: String(message),
            annotations: {
              ...fiber.getRef(References.CurrentLogAnnotations),
            },
          });
        }),
      ]),
    ),
    Effect.as(logs),
  );
}

interface BinaryFixture {
  readonly root: string;
  readonly settings: Record<string, unknown>;
  readonly writeBinary: (relative: string, version?: string) => string;
}

class Fixture extends Context.Service<Fixture, BinaryFixture>()(
  "@marimo/test/binaryResolution/Fixture",
) {}

const binaryLayer = Layer.unwrap(
  Effect.gen(function* () {
    const temporary = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeFs.mkdtempDisposableSync(
          NodePath.join(NodeOs.tmpdir(), "marimo-binaries-"),
        ),
      ),
      (directory) => Effect.sync(() => directory.remove()),
    );
    const root = temporary.path;
    const settings: Record<string, unknown> = {};
    const writeBinary = (relative: string, version = "1.4.0") => {
      const path = NodePath.join(root, relative);
      NodeFs.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFs.writeFileSync(path, `#!/bin/sh\nprintf 'server ${version}\\n'\n`, {
        mode: 0o755,
      });
      return path;
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        vi.stubEnv("PATH", NodePath.join(root, "on path"));
      }),
      () => Effect.sync(() => vi.unstubAllEnvs()),
    );
    return Layer.mergeAll(
      Layer.succeed(Fixture, { root, settings, writeBinary }),
      VsCodeTest.layerWith(
        {
          installedExtensions: ["test.extension"],
          extensionPaths: {
            "test.extension": NodePath.join(root, "extension"),
          },
        },
        {
          workspace: {
            getWorkspaceFolders: Effect.succeed(
              Option.some([
                { uri: VsCodeTest.Uri.file(root), name: "workspace", index: 0 },
                {
                  uri: VsCodeTest.Uri.file(NodePath.join(root, "second")),
                  name: "second",
                  index: 1,
                },
              ]),
            ),
            getConfiguration: (section) =>
              Effect.succeed({
                // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
                get: <T>(key: string) => {
                  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                  return settings[`${section}.${key}`] as T;
                },
                has: (key: string) => `${section}.${key}` in settings,
                inspect: () => undefined,
                async update() {},
              }),
          },
        },
      ),
    );
  }),
);

const specs: ReadonlyArray<ServerBinary> = [
  { name: "ty", minimumVersion: "0.0.63", extensionId: "test.extension" },
  {
    name: "pyrefly",
    minimumVersion: "1.0.0",
    extensionId: "test.extension",
    pathSetting: "lspPath",
    binaryDir: ["bin"],
  },
  { name: "ruff", minimumVersion: "0.16.0", extensionId: "test.extension" },
];

// Real executable fixtures exercise both filesystem lookup and --version.
Vitest.describe.skipIf(process.platform === "win32")(
  "configured binaries",
  () => {
    const it = EffectTest.make(binaryLayer);

    for (const spec of specs) {
      it.live.each(["absolute", "relative", "home", "PATH"] as const)(
        `${spec.name}: resolves a %s companion path before the bundled binary`,
        Effect.fn(function* (form) {
          const { settings, writeBinary } = yield* Fixture;
          const relative =
            form === "home"
              ? "home/my server"
              : form === "PATH"
                ? "on path/my-server"
                : "tools/my server";
          const path = writeBinary(relative);
          writeBinary(
            NodePath.join(
              "extension",
              ...(spec.binaryDir ?? ["bundled", "libs", "bin"]),
              spec.name,
            ),
          );
          const configured =
            form === "absolute"
              ? path
              : form === "home"
                ? `~/${NodePath.relative(NodeOs.homedir(), path)}`
                : form === "PATH"
                  ? "my-server"
                  : `./${relative}`;
          settings[`${spec.name}.${spec.pathSetting ?? "path"}`] =
            spec.name === "ty" ? [configured] : configured;
          Vitest.expect(
            yield* resolveServerBinary(spec, Effect.succeed(Option.none())),
          ).toEqual(
            Option.some(
              BinarySource.CompanionExtension({
                extensionId: spec.extensionId,
                kind: "configured",
                path,
              }),
            ),
          );
        }),
      );
    }

    it.live.each(["absolute", "relative", "home", "PATH"] as const)(
      "resolves a %s marimo override before companion settings",
      Effect.fn(function* (form) {
        const { settings, writeBinary } = yield* Fixture;
        const path = writeBinary("home/my-server");
        const onPath = writeBinary("on path/my-server");
        settings["pyrefly.lspPath"] = writeBinary("companion");
        writeBinary("extension/bin/pyrefly");
        const configured =
          form === "absolute"
            ? path
            : form === "home"
              ? `~/${NodePath.relative(NodeOs.homedir(), path)}`
              : form === "PATH"
                ? "my-server"
                : "home/my-server";
        const result = yield* resolveServerBinary(
          specs[1],
          Effect.succeed(Option.some(configured)),
        );
        Vitest.expect(result).toEqual(
          Option.some(
            BinarySource.UserConfigured({
              path: form === "PATH" ? onPath : path,
            }),
          ),
        );
      }),
    );

    it.live.each([
      "missing",
      "old",
      "malformed",
      "not executable",
      "directory",
    ] as const)(
      "falls back from a %s configured binary to the bundled binary",
      Effect.fn(function* (failure) {
        const { root, settings, writeBinary } = yield* Fixture;
        const invalid = NodePath.join(root, "invalid");
        if (failure === "old") writeBinary("invalid", "0.0.1");
        if (failure === "malformed") writeBinary("invalid", "unknown");
        if (failure === "not executable") {
          writeBinary("invalid");
          NodeFs.chmodSync(invalid, 0o644);
        }
        if (failure === "directory") NodeFs.mkdirSync(invalid);
        settings["pyrefly.lspPath"] = invalid;
        const bundled = writeBinary("extension/bin/pyrefly");
        Vitest.expect(
          yield* resolveServerBinary(
            specs[1],
            Effect.succeed(Option.some(invalid)),
          ),
        ).toEqual(
          Option.some(
            BinarySource.CompanionExtension({
              extensionId: "test.extension",
              kind: "bundled",
              path: bundled,
            }),
          ),
        );
      }),
    );

    it.live(
      "falls back from an invalid marimo override to companion settings",
      Effect.fn(function* () {
        const { settings, writeBinary } = yield* Fixture;
        const path = writeBinary("configured");
        settings["pyrefly.lspPath"] = "./configured";
        Vitest.expect(
          yield* resolveServerBinary(
            specs[1],
            Effect.succeed(Option.some("./missing")),
          ),
        ).toEqual(
          Option.some(
            BinarySource.CompanionExtension({
              extensionId: "test.extension",
              kind: "configured",
              path,
            }),
          ),
        );
      }),
    );

    it.live.each([specs[0], specs[2]])(
      "tries all $name path-list entries in order",
      Effect.fn(function* (spec) {
        const { settings, writeBinary } = yield* Fixture;
        const old = writeBinary("old", "0.0.1");
        const path = writeBinary("good");
        const later = writeBinary("later");
        settings[`${spec.name}.path`] = ["./missing", old, path, later];
        Vitest.expect(
          yield* resolveServerBinary(spec, Effect.succeed(Option.none())),
        ).toEqual(
          Option.some(
            BinarySource.CompanionExtension({
              extensionId: "test.extension",
              kind: "configured",
              path,
            }),
          ),
        );
      }),
    );

    it.live(
      "does not search PATH for an explicit missing relative path",
      Effect.fn(function* () {
        const { settings, writeBinary } = yield* Fixture;
        writeBinary("on path/my-server");
        settings["pyrefly.lspPath"] = "./my-server";
        Vitest.expect(
          yield* resolveServerBinary(specs[1], Effect.succeed(Option.none())),
        ).toEqual(Option.none());
      }),
    );

    it.live(
      "prefers a workspace executable over a command of the same name on PATH",
      Effect.fn(function* () {
        const { settings, writeBinary } = yield* Fixture;
        const path = writeBinary("my-server");
        writeBinary("on path/my-server");
        settings["pyrefly.lspPath"] = "my-server";
        Vitest.expect(
          yield* resolveServerBinary(specs[1], Effect.succeed(Option.none())),
        ).toEqual(
          Option.some(
            BinarySource.CompanionExtension({
              extensionId: "test.extension",
              kind: "configured",
              path,
            }),
          ),
        );
      }),
    );
  },
);

Vitest.describe.skipIf(process.platform !== "win32")(
  "Windows configured binaries",
  () => {
    const it = EffectTest.make(binaryLayer);

    it.live.each(["absolute", "relative", "home", "PATH"] as const)(
      "resolves a %s path with Windows separators and executable suffixes",
      Effect.fn(function* (form) {
        vi.stubEnv("PATHEXT", ".COM;.EXE");
        const { settings, writeBinary } = yield* Fixture;
        const relative =
          form === "home"
            ? "home/my-server.EXE"
            : form === "PATH"
              ? "on path/my-server.EXE"
              : "tools/my-server.EXE";
        const path = writeBinary(relative);
        // Path lookup uses the real Windows filesystem; only execution of the
        // stand-in .exe is faked. POSIX cases above run real shell executables.
        const execute = yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi
              .spyOn(NodeChildProcess, "execFileSync")
              .mockReturnValue("pyrefly 1.4.0\n"),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        settings["pyrefly.lspPath"] =
          form === "absolute"
            ? path
            : form === "relative"
              ? ".\\tools\\my-server"
              : form === "home"
                ? `~\\${NodePath.relative(NodeOs.homedir(), path)}`
                : "my-server";
        Vitest.expect(
          yield* resolveServerBinary(specs[1], Effect.succeed(Option.none())),
        ).toEqual(
          Option.some(
            BinarySource.CompanionExtension({
              extensionId: "test.extension",
              kind: "configured",
              path,
            }),
          ),
        );
        Vitest.expect(execute).toHaveBeenCalledWith(path, ["--version"], {
          encoding: "utf8",
          timeout: 10_000,
        });
      }),
    );
  },
);
