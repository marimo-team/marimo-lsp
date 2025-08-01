import * as vscode from "vscode";

import * as fs from "node:fs";
import * as util from "node:util";
import * as path from "node:path";

export const channel = vscode.window.createOutputChannel("marimo-lsp", {
  log: true,
});

// TODO: Make configurable. Assumes output is in ./dist, not true in prod.
const devLogDir = path.join(__dirname, "../../logs");

class FileLogger {
  private logStream: fs.WriteStream;
  private level: vscode.LogLevel;

  constructor(config: { level: vscode.LogLevel }) {
    this.level = config.level;
    if (!fs.existsSync(devLogDir)) {
      fs.mkdirSync(devLogDir, { recursive: true });
    }
    const logFilePath = path.join(devLogDir, `marimo-lsp.log`);
    this.logStream = fs.createWriteStream(logFilePath, {
      flags: "w",
    });
    this.log(
      vscode.LogLevel.Info,
      "Logging",
      `Log file initialized at ${logFilePath}`,
    );
  }

  log(
    level: vscode.LogLevel,
    category: string,
    message: string,
    data?: unknown,
  ) {
    if (level > this.level) return;
    const levels = ["off", "trace", "debug", "info", "warn", "error"] as const;
    let dataStr = "";
    if (data !== undefined) {
      dataStr = ` | ${JSON.stringify(data)}`;
    }
    this.logStream.write(
      `${timestamp()} [${levels[level]}] [${category}] ${message}${dataStr}\n`,
    );
  }

  close() {
    this.logStream.close();
  }
}

const fileLogger = new FileLogger({ level: vscode.LogLevel.Debug });

export const Logger = {
  trace(category: string, message: string, ...messages: unknown[]) {
    channel.trace(util.format(`[${category}]`, message, ...messages));
    fileLogger.log(vscode.LogLevel.Trace, category, message, messages[0]);
  },
  debug(category: string, message: string, ...messages: unknown[]) {
    channel.debug(util.format(`[${category}]`, message, ...messages));
    fileLogger.log(vscode.LogLevel.Debug, category, message, messages[0]);
  },
  info(category: string, message: string, ...messages: unknown[]) {
    channel.info(util.format(`[${category}]`, message, ...messages));
    fileLogger.log(vscode.LogLevel.Info, category, message, messages[0]);
  },
  warn(category: string, message: string, ...messages: unknown[]) {
    channel.warn(util.format(`[${category}]`, message, ...messages));
    fileLogger.log(vscode.LogLevel.Warning, category, message, messages[0]);
  },
  error(category: string, message: string, ...errors: unknown[]) {
    channel.error(util.format(`[${category}]`, message, ...errors));
    const error = errors[0];
    fileLogger.log(
      vscode.LogLevel.Error,
      category,
      message,
      error instanceof Error
        ? { message: error.message, stack: error.stack, name: error.name }
        : error,
    );
  },
  close: () => fileLogger.close(),
};

function timestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  const hours = now.getHours().toString().padStart(2, "0");
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const seconds = now.getSeconds().toString().padStart(2, "0");
  const ms = now.getMilliseconds().toString().padStart(3, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}
