import { Effect, Option } from "effect";
import type { OutputChannel } from "../services/OutputChannel.ts";
import type { VsCode } from "../services/VsCode.ts";

export const showErrorAndPromptLogs = Effect.fnUntraced(function* (
  msg: string,
  deps: {
    code: VsCode;
    channel: OutputChannel;
  },
) {
  const selection = yield* deps.code.window.showErrorMessage(
    `${msg}\n\nSee logs for details.`,
    { items: ["Open Logs"] },
  );

  if (Option.isSome(selection)) {
    deps.channel.show();
  }
});
