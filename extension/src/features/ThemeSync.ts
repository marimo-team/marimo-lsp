import { Data, Effect, Layer, Option, Queue, Stream } from "effect";

import { MarimoClient } from "../lsp/MarimoClient.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { VsCode } from "../platform/VsCode.ts";
import type { NotebookId } from "../schemas/MarimoNotebookDocument.ts";

type ThemeSyncUpdate = Data.TaggedEnum<{
  Theme: { readonly theme: "light" | "dark" };
  ActiveNotebook: { readonly notebook: Option.Option<NotebookId> };
}>;
const ThemeSyncUpdate = Data.taggedEnum<ThemeSyncUpdate>();

/**
 * Syncs VS Code's active color theme to all marimo kernel sessions so
 * that `mo.app_meta().theme` returns the correct value.
 *
 * Reacts to both theme changes and new notebooks appearing, ensuring
 * every session always has the correct theme.
 */
export const ThemeSyncLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const marimo = yield* MarimoClient;
    const editorRegistry = yield* NotebookEditorRegistry;

    // Funnel both sources into one queue through per-source fibers (rather
    // than `Stream.zipLatest`, whose inner subscriptions only attach several
    // scheduler ticks after the layer is built) so no update is missed.
    const updates = yield* Queue.unbounded<ThemeSyncUpdate>();
    yield* Effect.forkScoped(
      code.window.colorThemeChanges.pipe(
        Stream.changes,
        Stream.runForEach((theme) =>
          Queue.offer(updates, ThemeSyncUpdate.Theme({ theme })),
        ),
      ),
    );
    yield* Effect.forkScoped(
      editorRegistry.streamActiveNotebookChanges.pipe(
        Stream.runForEach((notebook) =>
          Queue.offer(updates, ThemeSyncUpdate.ActiveNotebook({ notebook })),
        ),
      ),
    );

    const sendTheme = Effect.fn("ThemeSync.sync")(function* (
      theme: "light" | "dark",
    ) {
      yield* marimo.setDisplayTheme({ theme }).pipe(
        Effect.catch(
          Effect.fn(function* (error) {
            yield* Effect.logWarning("Failed to sync theme").pipe(
              Effect.annotateLogs({ error }),
            );
          }),
        ),
      );
    });

    // A single consumer tracks the latest theme and whether a marimo notebook
    // is active: theme changes re-sync an active session, and a notebook
    // becoming active receives the current theme.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        let theme = Option.none<"light" | "dark">();
        let hasActiveNotebook = false;
        yield* Stream.fromQueue(updates).pipe(
          Stream.runForEach((update) =>
            ThemeSyncUpdate.$match(update, {
              Theme: (updated) => {
                theme = Option.some(updated.theme);
                return hasActiveNotebook
                  ? sendTheme(updated.theme)
                  : Effect.void;
              },
              ActiveNotebook: ({ notebook }) => {
                hasActiveNotebook = Option.isSome(notebook);
                return hasActiveNotebook && Option.isSome(theme)
                  ? sendTheme(theme.value)
                  : Effect.void;
              },
            }),
          ),
        );
      }),
    );
  }),
);
