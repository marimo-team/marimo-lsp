import { Effect, Option } from "effect";

import { OutputChannel } from "../platform/OutputChannel.ts";
import { VsCode } from "../platform/VsCode.ts";

export const showErrorAndPromptLogs = Effect.fn(function* (
  msg: string,
  options: { channel?: { name: string; show(): void } } = {},
) {
  const code = yield* VsCode;
  const defaultChannel = yield* OutputChannel;
  const channel = options.channel ?? defaultChannel;

  const selection = yield* code.window.showErrorMessage(
    `${msg}\n\nSee ${channel.name} logs for details.`,
    { items: ["Open Logs"] },
  );

  if (Option.isSome(selection)) {
    channel.show();
    return;
  }
});
