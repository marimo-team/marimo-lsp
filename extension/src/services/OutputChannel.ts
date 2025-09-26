import { Context, Layer } from "effect";
import type * as vscode from "vscode";

export class OutputChannel extends Context.Tag("OutputChannel")<
  OutputChannel,
  vscode.OutputChannel
>() {
  static layer = (channel: vscode.OutputChannel) =>
    Layer.succeed(this, channel);
}
