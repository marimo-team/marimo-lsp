import { Effect } from "effect";

import { defineMarimoCommand } from "../commands.ts";
import { Links } from "../lib/links.ts";
import { openExternalUrl } from "../lib/openExternalUrl.ts";
import { GeneratedMarimoCommands } from "./MarimoCommands.gen.ts";

const reportIssue = Effect.fn(function* () {
  yield* openExternalUrl(Links.issues);
});

export const reportIssueCommand = defineMarimoCommand(
  GeneratedMarimoCommands.reportIssue,
  reportIssue,
);
