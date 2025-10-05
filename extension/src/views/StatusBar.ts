import { Effect } from "effect";
import { VsCode } from "../services/VsCode.ts";

export type StatusBarAlignment = "Left" | "Right";
export type StatusBarCommand = string;

/**
 * Manages VS Code status bar items with automatic disposal.
 *
 * @example Basic usage
 * ```ts
 * const program = Effect.gen(function* () {
 *   const statusBar = yield* StatusBar;
 *
 *   // Create a simple status bar item
 *   const item = yield* statusBar.createSimpleStatusBarItem({
 *     id: "marimo.status",
 *     text: "$(check) marimo Ready",
 *     tooltip: "marimo is ready",
 *     command: "marimo.showInfo",
 *     alignment: "Left",
 *     priority: 100,
 *   });
 *
 *   // Update the item later
 *   yield* item.setText("$(sync~spin) marimo Running");
 *   yield* item.setTooltip("marimo is executing...");
 * });
 * ```
 *
 * @example Manual control
 * ```ts
 * const program = Effect.gen(function* () {
 *   const statusBar = yield* StatusBar;
 *
 *   const item = yield* statusBar.createStatusBarItem(
 *     "marimo.custom",
 *     "Right",
 *     50
 *   );
 *
 *   yield* item.setText("Custom");
 *   yield* item.setCommand("marimo.doSomething");
 *   yield* item.show();
 *
 *   // Item is automatically disposed when scope ends
 * });
 * ```
 */
export class StatusBar extends Effect.Service<StatusBar>()("StatusBar", {
  scoped: Effect.gen(function* () {
    const code = yield* VsCode;

    return {
      /**
       * Creates a status bar item with automatic cleanup on scope disposal.
       *
       * @param id - Unique identifier for the status bar item
       * @param alignment - Position alignment (Left or Right)
       * @param priority - Display priority (higher values appear more to the left/right)
       */
      createStatusBarItem(
        id: string,
        alignment: StatusBarAlignment = "Left",
        priority?: number,
      ) {
        // Import the actual vscode module inside the callback
        return Effect.gen(function* () {
          const alignmentValue =
            alignment === "Left"
              ? code.StatusBarAlignment.Left
              : code.StatusBarAlignment.Right;

          const item = yield* code.window.createStatusBarItem(
            id,
            alignmentValue,
            priority,
          );

          return {
            /**
             * Sets the text displayed in the status bar.
             */
            setText(text: string) {
              return Effect.sync(() => {
                item.text = text;
              });
            },

            /**
             * Sets the tooltip that appears on hover.
             */
            setTooltip(
              tooltip:
                | string
                | { value: string; isTrusted?: boolean; supportHtml?: boolean },
            ) {
              return Effect.sync(() => {
                if (typeof tooltip === "string") {
                  item.tooltip = tooltip;
                } else {
                  item.tooltip = new code.MarkdownString(
                    tooltip.value,
                    tooltip.supportHtml,
                  );
                  if (tooltip.isTrusted !== undefined) {
                    item.tooltip.isTrusted = tooltip.isTrusted;
                  }
                }
              });
            },

            /**
             * Sets the command to execute when the item is clicked.
             */
            setCommand(command: StatusBarCommand) {
              return Effect.sync(() => {
                item.command = command;
              });
            },

            /**
             * Sets the background color. Use sparingly.
             */
            setBackgroundColor(color: string) {
              return Effect.sync(() => {
                item.backgroundColor = new code.ThemeColor(color);
              });
            },

            /**
             * Sets the foreground color (text color).
             */
            setColor(color: string) {
              return Effect.sync(() => {
                item.color = color;
              });
            },

            /**
             * Shows the status bar item.
             */
            show() {
              return Effect.sync(() => item.show());
            },

            /**
             * Hides the status bar item.
             */
            hide() {
              return Effect.sync(() => item.hide());
            },

            /**
             * Direct access to the underlying VS Code StatusBarItem.
             * Use with caution - prefer the provided methods.
             */
            get raw() {
              return item;
            },
          };
        });
      },

      /**
       * Creates a simple status bar item with text and optional command.
       * A convenience method for common use cases.
       */
      createSimpleStatusBarItem: ({
        id,
        text,
        tooltip,
        command,
        alignment = "Left",
        priority,
        backgroundColor,
        color,
      }: {
        id: string;
        text: string;
        tooltip?: string;
        command?: StatusBarCommand;
        alignment?: StatusBarAlignment;
        priority?: number;
        backgroundColor?: string;
        color?: string;
      }) =>
        Effect.gen(function* () {
          const statusBar = yield* StatusBar;
          const item = yield* statusBar.createStatusBarItem(
            id,
            alignment,
            priority,
          );
          yield* item.setText(text);
          if (tooltip) {
            yield* item.setTooltip(tooltip);
          }
          if (command) {
            yield* item.setCommand(command);
          }
          if (backgroundColor) {
            yield* item.setBackgroundColor(backgroundColor);
          }
          if (color) {
            yield* item.setColor(color);
          }
          yield* item.show();
          return item;
        }),
    };
  }).pipe(Effect.annotateLogs("service", "StatusBar")),
}) {}
