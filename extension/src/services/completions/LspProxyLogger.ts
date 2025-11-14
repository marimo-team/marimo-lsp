import * as vscode from "vscode";

/**
 * Shared logger for LSP proxy components.
 * Logs to a dedicated VS Code output channel.
 */
class LspProxyLogger {
  private static instance: LspProxyLogger;
  private outputChannel: vscode.OutputChannel;

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel("marimo-lsp-proxy");
  }

  public static getInstance(): LspProxyLogger {
    if (!LspProxyLogger.instance) {
      LspProxyLogger.instance = new LspProxyLogger();
    }
    return LspProxyLogger.instance;
  }

  public log(component: string, message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${component}] ${message}`;

    if (args.length > 0) {
      this.outputChannel.appendLine(formattedMessage);
      for (const arg of args) {
        if (typeof arg === "object") {
          this.outputChannel.appendLine(JSON.stringify(arg, null, 2));
        } else {
          this.outputChannel.appendLine(String(arg));
        }
      }
    } else {
      this.outputChannel.appendLine(formattedMessage);
    }
  }

  public warn(component: string, message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${component}] WARNING: ${message}`;

    if (args.length > 0) {
      this.outputChannel.appendLine(formattedMessage);
      for (const arg of args) {
        if (typeof arg === "object") {
          this.outputChannel.appendLine(JSON.stringify(arg, null, 2));
        } else {
          this.outputChannel.appendLine(String(arg));
        }
      }
    } else {
      this.outputChannel.appendLine(formattedMessage);
    }
  }

  public show(): void {
    this.outputChannel.show();
  }

  public dispose(): void {
    this.outputChannel.dispose();
  }
}

// Export singleton instance
export const lspProxyLogger = LspProxyLogger.getInstance();
