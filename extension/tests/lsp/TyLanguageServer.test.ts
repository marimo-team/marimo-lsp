import * as Vitest from "@effect/vitest";
import { Effect } from "effect";

import * as TyLanguageServer from "../../src/lsp/TyLanguageServer.ts";
import * as EffectTest from "../lib/EffectTest.ts";
import * as TestTyLanguageServer from "./TestTyLanguageServer.ts";

Vitest.describe("TyLanguageServer", () => {
  Vitest.it(
    "points at the ty extension and the path setting when no binary is found",
    () => {
      const error = new TyLanguageServer.BinaryNotFoundError({
        serverVersion: "0.0.63",
      });

      Vitest.expect(error.format()).toBe(
        [
          "No ty 0.0.63 or newer binary was found.",
          "Python completions and type diagnostics are unavailable. You can still edit and run notebooks.",
          "To enable these features, install or update the official ty extension (astral-sh.ty) or set marimo.ty.path, then reload VS Code.",
        ].join("\n"),
      );
    },
  );

  Vitest.describe("when the prompt is ignored", () => {
    const it = EffectTest.make(TestTyLanguageServer.layer);

    it.effect(
      "warns about unavailable Python language features at most once per session",
      Effect.fn(function* () {
        const ty = yield* TestTyLanguageServer.Service;
        yield* Effect.all([ty.notify, ty.notify], {
          concurrency: "unbounded",
        });

        const snapshot = yield* ty.snapshot;
        Vitest.expect(snapshot.warningMessages).toEqual([
          "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Install the recommended ty extension to enable them. You can still edit and run notebooks.",
        ]);
      }),
    );
  });

  Vitest.describe("when the prompt is permanently dismissed", () => {
    const it = EffectTest.make(
      TestTyLanguageServer.layerWith(
        TestTyLanguageServer.Scenario.DismissPermanently(),
      ),
    );

    it.effect(
      "never prompts again once the user dismisses it",
      Effect.fn(function* () {
        const ty = yield* TestTyLanguageServer.Service;
        yield* ty.notify;
        yield* ty.notifyInNewSession();

        const snapshot = yield* ty.snapshot;
        Vitest.expect(snapshot.warningMessages).toHaveLength(1);
        Vitest.expect(snapshot.storage).toEqual({
          "languageServer.ty.installPromptDismissed": true,
        });
        Vitest.expect(snapshot.telemetry).toEqual([
          "prompt_shown",
          "dont_show_again",
          "prompt_suppressed",
        ]);
      }),
    );
  });

  Vitest.describe("when replaying the prompt during local development", () => {
    const it = EffectTest.make(
      TestTyLanguageServer.layerWith(
        TestTyLanguageServer.Scenario.ReplayDismissal(),
      ),
    );

    it.effect(
      "replays saved dismissals without writing state during local development",
      Effect.fn(function* () {
        const ty = yield* TestTyLanguageServer.Service;
        yield* ty.notify;
        yield* ty.notify;
        yield* ty.notifyInNewSession(2);

        const snapshot = yield* ty.snapshot;
        Vitest.expect(snapshot.warningMessages).toHaveLength(2);
        Vitest.expect(snapshot.storageWrites).toBe(0);
        Vitest.expect(snapshot.storage).toEqual({
          "languageServer.ty.installPromptDismissed": true,
        });
      }),
    );
  });

  Vitest.describe("when installing the companion extension", () => {
    const it = EffectTest.make(
      TestTyLanguageServer.layerWith(TestTyLanguageServer.Scenario.Install()),
    );

    it.effect(
      "installs the companion extension and reloads when selected",
      Effect.fn(function* () {
        const ty = yield* TestTyLanguageServer.Service;
        yield* ty.notify;

        const snapshot = yield* ty.snapshot;
        Vitest.expect(snapshot.storage).toEqual({});
        Vitest.expect(snapshot.telemetry).toEqual([
          "prompt_shown",
          "install",
          "install_succeeded",
        ]);
        Vitest.expect(snapshot.executions).toEqual([
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
    const it = EffectTest.make(
      TestTyLanguageServer.layerWith(TestTyLanguageServer.Scenario.Installed()),
    );

    it.effect(
      "asks an existing ty extension to be updated instead of installed",
      Effect.fn(function* () {
        const ty = yield* TestTyLanguageServer.Service;
        yield* ty.notify;
        yield* ty.notifyInNewSession();

        const snapshot = yield* ty.snapshot;
        Vitest.expect(snapshot.warningMessages).toEqual([
          "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Update the ty extension to enable them. You can still edit and run notebooks.",
          "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Update the ty extension to enable them. You can still edit and run notebooks.",
        ]);
        Vitest.expect(snapshot.executions).toEqual([
          { command: "extension.open", args: ["astral-sh.ty"] },
          { command: "extension.open", args: ["astral-sh.ty"] },
        ]);
        Vitest.expect(snapshot.storage).toEqual({});
      }),
    );
  });

  Vitest.describe("when installation fails", () => {
    const it = EffectTest.make(
      TestTyLanguageServer.layerWith(
        TestTyLanguageServer.Scenario.InstallFailure(),
      ),
    );

    it.effect(
      "reports a companion extension installation failure without prompting to reload",
      Effect.fn(function* () {
        const ty = yield* TestTyLanguageServer.Service;
        yield* ty.notify;

        const snapshot = yield* ty.snapshot;
        Vitest.expect(snapshot.executions).toEqual([
          {
            command: "workbench.extensions.installExtension",
            args: ["astral-sh.ty"],
          },
        ]);
        Vitest.expect(snapshot.telemetry).toEqual([
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
