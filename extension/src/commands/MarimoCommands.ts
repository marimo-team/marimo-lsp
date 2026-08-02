import { Schema } from "effect";
import type * as vscode from "vscode";

import { withFirstArgument } from "../commands.ts";
import { GeneratedMarimoCommands } from "./MarimoCommands.gen.ts";

const UriSchema = Schema.declare<vscode.Uri>(
  (value): value is vscode.Uri =>
    typeof value === "object" &&
    value !== null &&
    "scheme" in value &&
    typeof value.scheme === "string" &&
    "path" in value &&
    typeof value.path === "string" &&
    "with" in value &&
    typeof value.with === "function" &&
    "toString" in value &&
    typeof value.toString === "function",
  { identifier: "vscode.Uri" },
);

/**
 * Commands contributed by this extension, with exceptional contracts refined
 * here. Generated commands use the conventional `[] -> void` contract.
 */
export const MarimoCommands = {
  ...GeneratedMarimoCommands,
  openAsMarimoNotebook: withFirstArgument(
    GeneratedMarimoCommands.openAsMarimoNotebook,
    Schema.UndefinedOr(Schema.Union(Schema.String, UriSchema)),
  ),
} as const;
