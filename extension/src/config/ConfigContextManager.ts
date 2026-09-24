import {
  Context,
  Effect,
  Layer,
  Option,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";

import * as NotebookDocumentSessions from "../notebook/NotebookDocumentSessions.ts";
import * as NotebookSessionResources from "../notebook/NotebookSessionResources.ts";
import * as VsCode from "../platform/VsCode.ts";
import type { MarimoConfig } from "../types.ts";
import * as NotebookConfiguration from "./NotebookConfiguration.ts";

export interface Interface {
  readonly desiredRevision: Effect.Effect<number>;
  readonly desiredChanges: Stream.Stream<number>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/ConfigContextManager",
) {}

/**
 * Mirrors kernel configuration into VS Code context keys for UI:
 * - "marimo.config.runtime.on_cell_change" - Current on_cell_change mode ("autorun" | "lazy")
 * - "marimo.config.runtime.auto_reload" - Current auto_reload mode ("off" | "lazy" | "autorun")
 *
 * The service exposes desired-configuration progress so callers can observe
 * when an active-session change has entered the ordered write pipeline.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const code = yield* VsCode.Service;
    const documentSessions = yield* NotebookDocumentSessions.Service;
    const sessionResources = yield* NotebookSessionResources.Service;
    const desiredConfiguration = yield* SubscriptionRef.make(
      Option.none<MarimoConfig>(),
    );
    const desiredRevision = yield* SubscriptionRef.make(0);
    const publishDesired = (configuration: Option.Option<MarimoConfig>) =>
      SubscriptionRef.set(desiredConfiguration, configuration).pipe(
        Effect.andThen(
          SubscriptionRef.update(desiredRevision, (revision) => revision + 1),
        ),
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
            Stream.fromEffect(publishDesired(Option.none<MarimoConfig>())),
          onSome: (session) =>
            Stream.fromEffect(
              sessionResources
                .runScoped(
                  session,
                  NotebookConfiguration.Service.pipe(
                    Effect.flatMap((configuration) =>
                      configuration.changes.pipe(
                        Stream.runForEach(publishDesired),
                      ),
                    ),
                  ),
                )
                .pipe(
                  Scope.provide(session.scope),
                  Effect.catchTag(
                    "NotebookDocumentSessions.EndedError",
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
      { startImmediately: true },
    );
    yield* Effect.forkScoped(publishActiveConfiguration, {
      startImmediately: true,
    });

    return Service.of({
      desiredRevision: SubscriptionRef.get(desiredRevision),
      desiredChanges: SubscriptionRef.changes(desiredRevision),
    });
  }).pipe(Effect.withSpan("ConfigContextManager.layer")),
);
