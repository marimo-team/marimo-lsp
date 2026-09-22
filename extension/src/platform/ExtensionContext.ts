import { Context } from "effect";
import type * as vscode from "vscode";

export interface Interface
  extends
    Pick<
      vscode.ExtensionContext,
      "workspaceState" | "globalState" | "extensionUri" | "globalStorageUri"
    >,
    Partial<Pick<vscode.ExtensionContext, "extensionMode">> {}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/ExtensionContext",
) {}
