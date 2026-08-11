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

    // Each source has its own fiber that writes to one queue. A
    // `Stream.zipLatest` attaches its inner subscriptions too late and loses
    // updates.
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

    // One consumer keeps the latest theme. It sends the theme again when a
    // notebook becomes active.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        let theme = Option.none<"light" | "dark">();
        yield* Stream.fromQueue(updates).pipe(
          Stream.runForEach((update) =>
            ThemeSyncUpdate.$match(update, {
              // `set-display-theme` updates all running sessions and has no
              // notebook URI. Send it even if no notebook is focused.
              Theme: (updated) => {
                theme = Option.some(updated.theme);
                return sendTheme(updated.theme);
              },
              // A new active notebook can have a session without the current
              // theme. Send the theme again.
              ActiveNotebook: ({ notebook }) =>
                Option.isSome(notebook) && Option.isSome(theme)
                  ? sendTheme(theme.value)
                  : Effect.void,
            }),
          ),
        );
      }),
    );
  }),
);
