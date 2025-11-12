import { Effect, Option } from "effect";
import type { VsCode } from "../services/VsCode.ts";

export const showErrorAndPromptLogs = Effect.fnUntraced(function* (
  msg: string,
  deps: {
    code: VsCode;
    channel: { name: string; show(): void };
  },
) {
  const selection = yield* deps.code.window.showErrorMessage(
    `${msg}\n\nSee ${deps.channel.name} logs for details.`,
    { items: ["Open Logs"] },
  );

  if (Option.isSome(selection)) {
    deps.channel.show();
    return;
  }
});
