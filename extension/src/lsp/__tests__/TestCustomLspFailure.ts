import { Context, Data, Effect, Layer, Option, Ref } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as MarimoClient from "../MarimoClient.ts";

export type Scenario = Data.TaggedEnum<{
  OpenSettings: {};
  OpenLogs: {};
  Bundled: {};
}>;
export const Scenario = Data.taggedEnum<Scenario>();

export interface Snapshot {
  readonly prompts: ReadonlyArray<string>;
  readonly logsOpened: number;
  readonly executions: ReadonlyArray<TestVsCode.CommandExecution>;
}

export interface Interface {
  readonly notify: Effect.Effect<void>;
  readonly snapshot: Effect.Effect<Snapshot>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/CustomLspFailure",
) {}

export const layerWith = (scenario: Scenario) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<string>>([]);
      let logsOpened = 0;
      const vscodeLayer = TestVsCode.layerWith(
        {},
        {
          window: {
            showErrorMessage: (message, options = {}) =>
              Ref.update(prompts, (current) => [...current, message]).pipe(
                Effect.as(
                  Option.fromNullishOr(
                    options.items?.find(
                      (item) =>
                        item ===
                        (Scenario.$is("OpenLogs")(scenario)
                          ? "Open Logs"
                          : "Open Settings"),
                    ),
                  ),
                ),
              ),
          },
        },
      );
      const fixture = Layer.effect(
        Service,
        Effect.gen(function* () {
          const vscode = yield* TestVsCode.Service;
          const modes = Scenario.$is("Bundled")(scenario)
            ? (["wasm", "uv"] as const)
            : (["configured"] as const);
          const notifiers = yield* Effect.forEach(modes, (mode) =>
            MarimoClient.makeCustomLspFailureNotifier({
              mode,
              channel: {
                name: "marimo-lsp",
                show: () => {
                  logsOpened += 1;
                },
              },
            }),
          );
          const notify = Effect.all(notifiers, { discard: true });

          return Service.of({
            notify,
            snapshot: Effect.gen(function* () {
              const vscodeSnapshot = yield* vscode.snapshot;
              return {
                prompts: yield* Ref.get(prompts),
                logsOpened,
                executions: vscodeSnapshot.executions,
              };
            }),
          });
        }),
      ).pipe(Layer.provide(vscodeLayer));

      return Layer.merge(vscodeLayer, fixture);
    }),
  );
