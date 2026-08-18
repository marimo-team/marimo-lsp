import { Effect, Layer, Option, Stream } from "effect";

import { NotebookDocumentSessions } from "../notebook/NotebookDocumentSessions.ts";
import { NotebookSessionResources } from "../notebook/NotebookSessionResources.ts";
import { VsCode } from "../platform/VsCode.ts";
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

    const activeConfiguration = documentSessions.active.pipe(
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.succeed(Option.none()),
          onSome: (session) =>
            sessionResources.stream(
              session,
              Stream.unwrap(
                NotebookConfiguration.pipe(
                  Effect.map((configuration) => configuration.changes),
                ),
              ),
            ),
        }),
      ),
      Stream.changes,
    );

    yield* Effect.forkScoped(
      activeConfiguration.pipe(
        Stream.runForEach((configuration) => {
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
        }),
      ),
    );
  }).pipe(Effect.annotateLogs("service", "ConfigContextManager")),
);
