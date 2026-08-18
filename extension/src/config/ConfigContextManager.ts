import { Effect, Layer, Option, Scope, Stream, SubscriptionRef } from "effect";

import { NotebookDocumentSessions } from "../notebook/NotebookDocumentSessions.ts";
import { NotebookSessionResources } from "../notebook/NotebookSessionResources.ts";
import { VsCode } from "../platform/VsCode.ts";
import type { MarimoConfig } from "../types.ts";
import { NotebookConfiguration } from "./NotebookConfiguration.ts";

/**
 * Mirrors kernel configuration into VS Code context keys for UI:
 * - "marimo.config.runtime.on_cell_change" - Current on_cell_change mode ("autorun" | "lazy")
 * - "marimo.config.runtime.auto_reload" - Current auto_reload mode ("off" | "lazy" | "autorun")
 *
 * Pure side effect: nothing consumes this as a service.
 */
export const ConfigContextManagerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const documentSessions = yield* NotebookDocumentSessions;
    const sessionResources = yield* NotebookSessionResources;
    const desiredConfiguration = yield* SubscriptionRef.make(
      Option.none<MarimoConfig>(),
    );

    const updateContext = (configuration: Option.Option<MarimoConfig>) => {
      const onCellChange = Option.map(
        configuration,
        (config) => config.runtime?.on_cell_change ?? "autorun",
      ).pipe(Option.getOrElse(() => "autorun" as const));
      const autoReload = Option.map(
        configuration,
        (config) => config.runtime?.auto_reload ?? "off",
      ).pipe(Option.getOrElse(() => "off" as const));

      return Effect.all(
        [
          code.commands.setContext(
            "marimo.config.runtime.on_cell_change",
            onCellChange,
          ),
          code.commands.setContext(
            "marimo.config.runtime.auto_reload",
            autoReload,
          ),
        ],
        { discard: true },
      ).pipe(
        Effect.tap(() =>
          Effect.logTrace("Updated configuration context").pipe(
            Effect.annotateLogs({ onCellChange, autoReload }),
          ),
        ),
      );
    };

    const publishActiveConfiguration = documentSessions.active.pipe(
      Stream.switchMap(
        Option.match({
          onNone: () =>
            Stream.fromEffect(
              SubscriptionRef.set(
                desiredConfiguration,
                Option.none<MarimoConfig>(),
              ),
            ),
          onSome: (session) =>
            Stream.fromEffect(
              sessionResources
                .runScoped(
                  session,
                  NotebookConfiguration.pipe(
                    Effect.flatMap((configuration) =>
                      configuration.changes.pipe(
                        Stream.runForEach((value) =>
                          SubscriptionRef.set(desiredConfiguration, value),
                        ),
                      ),
                    ),
                  ),
                )
                .pipe(
                  Scope.provide(session.scope),
                  Effect.catchTag(
                    "NotebookDocumentSessionEndedError",
                    () => Effect.void,
                  ),
                ),
            ),
        }),
      ),
      Stream.runDrain,
    );

    // Keep the external writes outside the switched session stream. A switch
    // can interrupt an Effect.promise waiter, but cannot cancel the underlying
    // VS Code command. One manager-owned consumer preserves write order.
    yield* Effect.forkScoped(
      SubscriptionRef.changes(desiredConfiguration).pipe(
        Stream.runForEach(updateContext),
      ),
    );
    yield* Effect.forkScoped(publishActiveConfiguration);
  }).pipe(Effect.annotateLogs("service", "ConfigContextManager")),
);
