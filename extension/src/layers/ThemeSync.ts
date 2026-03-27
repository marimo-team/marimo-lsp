import { Effect, Layer, Stream } from "effect";

import { LanguageClient } from "../services/LanguageClient.ts";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import { VsCode } from "../services/VsCode.ts";

/**
 * Syncs VS Code's active color theme to all marimo kernel sessions so
 * that `mo.app_meta().theme` returns the correct value.
 *
 * Reacts to both theme changes and new notebooks appearing, ensuring
 * every session always has the correct theme.
 */
export const ThemeSyncLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const client = yield* LanguageClient;
    const editorRegistry = yield* NotebookEditorRegistry;

    yield* Effect.forkScoped(
      Stream.zipLatest(
        code.window.colorThemeChanges().pipe(Stream.changes),
        editorRegistry.streamActiveNotebookChanges(),
      ).pipe(
        Stream.mapEffect(
          Effect.fn("ThemeSync.sync")(function* ([theme]) {
            yield* client
              .executeCommand({
                command: "marimo.api",
                params: {
                  method: "set-display-theme",
                  params: { theme },
                },
              })
              .pipe(
                Effect.catchAll(
                  Effect.fn(function* (error) {
                    yield* Effect.logWarning("Failed to sync theme").pipe(
                      Effect.annotateLogs({ error }),
                    );
                  }),
                ),
              );
          }),
        ),
        Stream.runDrain,
      ),
    );
  }),
);
