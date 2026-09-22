import { Context, Effect, Layer } from "effect";
import type * as vscode from "vscode";

import { VsCode } from "./VsCode.ts";

export interface Interface extends Pick<
  vscode.LogOutputChannel,
  "name" | "show" | "trace" | "debug" | "info" | "warn" | "error"
> {}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/OutputChannel",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const code = yield* VsCode;
    return yield* code.window.createLogOutputChannel("marimo");
  }),
);
