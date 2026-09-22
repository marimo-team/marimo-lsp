import { Context, Effect, Layer, Scope } from "effect";

import * as VsCode from "../platform/VsCode.ts";

export type StatusBarAlignment = "Left" | "Right";
export type StatusBarCommand = string;

export interface StatusBarItem {
  readonly setText: (text: string) => Effect.Effect<void>;
  readonly setTooltip: (
    tooltip:
      | string
      | { value: string; isTrusted?: boolean; supportHtml?: boolean },
  ) => Effect.Effect<void>;
  readonly setCommand: (command: StatusBarCommand) => Effect.Effect<void>;
  readonly setBackgroundColor: (color?: string) => Effect.Effect<void>;
  readonly setColor: (color: string) => Effect.Effect<void>;
  readonly show: Effect.Effect<void>;
  readonly hide: Effect.Effect<void>;
}

export interface Interface {
  readonly createStatusBarItem: (
    id: string,
    alignment?: StatusBarAlignment,
    priority?: number,
  ) => Effect.Effect<StatusBarItem, never, Scope.Scope>;
  readonly createSimpleStatusBarItem: (options: {
    readonly id: string;
    readonly text: string;
    readonly tooltip?: string;
    readonly command?: StatusBarCommand;
    readonly alignment?: StatusBarAlignment;
    readonly priority?: number;
    readonly backgroundColor?: string;
    readonly color?: string;
  }) => Effect.Effect<StatusBarItem, never, Scope.Scope>;
}

/**
 * Manages VS Code status bar items with automatic disposal.
 *
 * @example Basic usage
 * ```ts
 * const program = Effect.gen(function* () {
 *   const statusBar = yield* StatusBar.Service;
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
 *   const statusBar = yield* StatusBar.Service;
 *
 *   const item = yield* statusBar.createStatusBarItem(
 *     "marimo.custom",
 *     "Right",
 *     50
 *   );
 *
 *   yield* item.setText("Custom");
 *   yield* item.setCommand("marimo.doSomething");
 *   yield* item.show;
 *
 *   // Item is automatically disposed when scope ends
 * });
 * ```
 */
export class Service extends Context.Service<Service, Interface>()(
  "@marimo/StatusBar",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const code = yield* VsCode.Service;

    const createStatusBarItem = Effect.fn("StatusBar.createStatusBarItem")(
      function* (
        id: string,
        alignment: StatusBarAlignment = "Left",
        priority?: number,
      ) {
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
          setBackgroundColor(color?: string) {
            return Effect.sync(() => {
              item.backgroundColor = color
                ? new code.ThemeColor(color)
                : undefined;
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
          show: Effect.sync(() => item.show()),

          /**
           * Hides the status bar item.
           */
          hide: Effect.sync(() => item.hide()),
        };
      },
    );

    const createSimpleStatusBarItem = Effect.fn(
      "StatusBar.createSimpleStatusBarItem",
    )(function* ({
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
    }) {
      const item = yield* createStatusBarItem(id, alignment, priority);
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
      yield* item.show;
      return item;
    });

    return Service.of({ createStatusBarItem, createSimpleStatusBarItem });
  }),
);
