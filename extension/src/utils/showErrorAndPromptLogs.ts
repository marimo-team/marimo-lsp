import { Effect } from "effect";
import type { OutputChannel } from "../services/OutputChannel.ts";
import type { VsCode } from "../services/VsCode.ts";

export const showErrorAndPromptLogs = (
  msg: string,
  deps: {
    code: VsCode;
    channel: OutputChannel;
  },
) =>
  deps.code.window
    .showErrorMessage(`${msg}\n\nSee logs for details.`, {
      items: ["Open Logs"],
    })
    .pipe(
      Effect.tap((selection) =>
        selection === "Open Logs"
          ? Effect.sync(() => deps.channel.show())
          : Effect.void,
      ),
    );
