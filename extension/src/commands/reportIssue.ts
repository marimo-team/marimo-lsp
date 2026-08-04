import { Effect } from "effect";

import { defineCommand } from "../commands.ts";
import { Links } from "../lib/links.ts";
import { openExternalUrl } from "../lib/openExternalUrl.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn(function* () {
  yield* openExternalUrl(Links.issues);
});

export default defineCommand(MarimoCommands.reportIssue, handler);
