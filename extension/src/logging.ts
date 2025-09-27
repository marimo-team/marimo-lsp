import * as util from "node:util";
import * as vscode from "vscode";

const channel = vscode.window.createOutputChannel("marimo", {
  log: true,
});

export const Logger = {
  trace(category: string, message?: string, ...messages: unknown[]) {
    if (!message) {
      channel.trace(category);
    } else {
      channel.trace(util.format(`[${category}]`, message, ...messages));
    }
  },
  debug(category: string, message?: string, ...messages: unknown[]) {
    if (!message) {
      channel.debug(category);
    } else {
      channel.debug(util.format(`[${category}]`, message, ...messages));
    }
  },
  info(category: string, message?: string, ...messages: unknown[]) {
    if (!message) {
      channel.info(category);
    } else {
      channel.info(util.format(`[${category}]`, message, ...messages));
    }
  },
  warn(category: string, message?: string, ...messages: unknown[]) {
    if (!message) {
      channel.warn(category);
    } else {
      channel.warn(util.format(`[${category}]`, message, ...messages));
    }
  },
  error(category: string, message?: string, ...errors: unknown[]) {
    if (!message) {
      channel.error(category);
    } else {
      channel.error(util.format(`[${category}]`, message, ...errors));
    }
  },
};
