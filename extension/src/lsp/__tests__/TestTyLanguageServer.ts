import { Context, Data, Effect, Layer, Option, Ref } from "effect";
import type * as vscode from "vscode";

import { Memento } from "../../__tests__/fake/ExtensionContext.ts";
import * as TelemetryTest from "../../__tests__/fake/Telemetry.ts";
import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as ExtensionContext from "../../platform/ExtensionContext.ts";
import * as Storage from "../../platform/Storage.ts";
import * as VsCode from "../../platform/VsCode.ts";
import * as Telemetry from "../../telemetry/Telemetry.ts";
import * as TyLanguageServer from "../TyLanguageServer.ts";

const DISMISSED_KEY = "languageServer.ty.installPromptDismissed";
const REPLAY_ENV = "MARIMO_REPLAY_TY_PROMPT";

export type Scenario = Data.TaggedEnum<{
  Ignore: {};
  DismissPermanently: {};
  ReplayDismissal: {};
  Install: {};
  Installed: {};
  InstallFailure: {};
}>;
export const Scenario = Data.taggedEnum<Scenario>();

export interface Snapshot {
  readonly warningMessages: ReadonlyArray<string>;
  readonly informationMessages: ReadonlyArray<string>;
  readonly errorMessages: ReadonlyArray<string>;
  readonly executions: ReadonlyArray<VsCodeTest.CommandExecution>;
  readonly telemetry: ReadonlyArray<Telemetry.TySetupAction>;
  readonly storage: Record<string, unknown>;
  readonly storageWrites: number;
}

export interface Interface {
  readonly notify: Effect.Effect<void>;
  readonly notifyInNewSession: (times?: number) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<Snapshot>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/TyLanguageServer",
) {}

class RecordingMemento extends Memento {
  writes = 0;

  override async update(key: string, value: unknown) {
    this.writes += 1;
    await super.update(key, value);
  }
}

const selectedItem = <T extends string>(
  options: vscode.MessageOptions & { items?: readonly T[] },
  item: string,
) => Option.fromNullishOr(options.items?.find((value) => value === item));

export const layerWith = (scenario: Scenario) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (Scenario.$is("ReplayDismissal")(scenario)) {
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
      if (Scenario.$is("ReplayDismissal")(scenario)) {
        yield* Effect.promise(() => globalState.update(DISMISSED_KEY, true));
        globalState.writes = 0;
      }

      const warningMessages = yield* Ref.make<ReadonlyArray<string>>([]);
      const informationMessages = yield* Ref.make<ReadonlyArray<string>>([]);
      const errorMessages = yield* Ref.make<ReadonlyArray<string>>([]);
      const executions = yield* Ref.make<
        ReadonlyArray<VsCodeTest.CommandExecution>
      >([]);
      const telemetry = yield* Ref.make<ReadonlyArray<Telemetry.TySetupAction>>(
        [],
      );

      const warningSelection = Scenario.$match(scenario, {
        Ignore: () => undefined,
        DismissPermanently: () => "Don't Show Again",
        ReplayDismissal: () => "Don't Show Again",
        Install: () => "Install ty Extension",
        Installed: () => "Show ty Extension",
        InstallFailure: () => "Install ty Extension",
      });

      const vscodeLayer = VsCodeTest.layerWith(
        {
          installedExtensions: Scenario.$is("Installed")(scenario)
            ? ["astral-sh.ty"]
            : [],
        },
        {
          window: {
            showWarningMessage: <T extends string>(
              message: string,
              options: vscode.MessageOptions & { items?: readonly T[] } = {},
            ) =>
              Ref.update(warningMessages, (current) => [
                ...current,
                message,
              ]).pipe(
                Effect.as(
                  warningSelection === undefined
                    ? Option.none<T>()
                    : selectedItem(options, warningSelection),
                ),
              ),
            showInformationMessage: <T extends string>(
              message: string,
              options: vscode.MessageOptions & { items?: readonly T[] } = {},
            ) =>
              Ref.update(informationMessages, (current) => [
                ...current,
                message,
              ]).pipe(Effect.as(selectedItem(options, "Reload Window"))),
            showErrorMessage: (message) =>
              Ref.update(errorMessages, (current) => [
                ...current,
                message,
              ]).pipe(Effect.as(Option.none())),
          },
          commands: {
            executeVSCode: (command, ...args) =>
              Ref.update(executions, (current) => [
                ...current,
                { command, args },
              ]).pipe(
                Effect.andThen(
                  Scenario.$is("InstallFailure")(scenario)
                    ? Effect.die(new Error("command rejected"))
                    : Effect.succeed(undefined),
                ),
              ),
          },
        },
      );
      const storageLayer = Storage.layer.pipe(
        Layer.provide(
          Layer.succeed(ExtensionContext.Service, {
            globalState,
            workspaceState: new Memento(),
            extensionUri: VsCodeTest.Uri.parse(
              "file:///test/extension/path",
              true,
            ),
            globalStorageUri: VsCodeTest.Uri.parse(
              "file://test/extension/libs",
              true,
            ),
          }),
        ),
      );
      const telemetryBase = yield* Telemetry.Service.pipe(
        Effect.provide(TelemetryTest.layer),
      );
      const telemetryLayer = Layer.succeed(Telemetry.Service, {
        ...telemetryBase,
        tySetup: (action) =>
          Ref.update(telemetry, (current) => [...current, action]),
      });
      const environment = Layer.mergeAll(
        vscodeLayer,
        storageLayer,
        telemetryLayer,
      );
      const fixture = Layer.effect(
        Service,
        Effect.gen(function* () {
          const context = yield* Effect.context<
            | VsCodeTest.Service
            | Storage.Service
            | Telemetry.Service
            | VsCode.Service
          >();
          const notify = yield* TyLanguageServer.makeMissingNotifier();

          return Service.of({
            notify,
            notifyInNewSession: (times = 1) =>
              TyLanguageServer.makeMissingNotifier().pipe(
                Effect.flatMap((notify) =>
                  Effect.forEach(Array.from({ length: times }), () => notify, {
                    discard: true,
                  }),
                ),
                Effect.provide(context),
              ),
            snapshot: Effect.all({
              warningMessages: Ref.get(warningMessages),
              informationMessages: Ref.get(informationMessages),
              errorMessages: Ref.get(errorMessages),
              executions: Ref.get(executions),
              telemetry: Ref.get(telemetry),
              storage: Effect.sync(() => globalState.toJSON()),
              storageWrites: Effect.sync(() => globalState.writes),
            }),
          });
        }),
      ).pipe(Layer.provide(environment));

      return Layer.merge(environment, fixture);
    }),
  );

export const layer = layerWith(Scenario.Ignore());
