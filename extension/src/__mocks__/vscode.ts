import * as NodeChildProcess from "node:child_process";
import * as jestMockVscode from "jest-mock-vscode";
import * as vitest from "vitest";
// biome-ignore lint: we need type-only import
import type * as vscode from "vscode";

const openProcesses: NodeChildProcess.ChildProcess[] = [];

export async function createVSCodeMock(vi: vitest.VitestUtils) {
  // biome-ignore lint/suspicious/noExplicitAny: any is ok
  const vscode = jestMockVscode.createVSCodeMock(vi) as any;

  vscode.workspace = vscode.workspace || {};
  let configMap: Record<string, unknown> = {};

  vscode.workspace.registerNotebookSerializer = vi.fn().mockReturnValue({
    dispose: vi.fn(),
  });

  // Add createTerminal mock
  vscode.window.createTerminal = vi.fn().mockImplementation(() => {
    let proc: NodeChildProcess.ChildProcess | undefined;
    return {
      processId: Promise.resolve(1),
      dispose: vi.fn().mockImplementation(() => {
        proc?.kill();
      }),
      sendText: vi.fn().mockImplementation((args: string) => {
        proc = NodeChildProcess.spawn(args, { shell: true });
        proc.stdout?.on("data", (data) => {
          const line = data.toString();
          if (line) {
            console.warn(line);
          }
        });
        proc.stderr?.on("data", (data) => {
          const line = data.toString();
          if (line) {
            console.warn(line);
          }
        });
        proc.on("error", (error) => {
          if (error) {
            console.warn(error);
          }
        });
        proc.on("close", (code) => {
          console.warn(`Process exited with code ${code}`);
        });
        openProcesses.push(proc);
      }),
      show: vi.fn(),
    };
  });

  vscode.workspace.getConfiguration = vi.fn().mockImplementation(() => {
    return {
      get: vi.fn().mockImplementation((key) => configMap[key]),
      update: vi.fn().mockImplementation((key, value) => {
        configMap[key] = value;
      }),
      set: vi.fn().mockImplementation((key, value) => {
        configMap[key] = value;
      }),
      reset: vi.fn().mockImplementation(() => {
        configMap = {};
      }),
    };
  });

  vscode.window.showErrorMessage = vi.fn().mockResolvedValue(undefined);

  vscode.window.createOutputChannel.mockImplementation(() => {
    return {
      trace: vi.fn().mockImplementation((...args) => console.log(...args)),
      debug: vi.fn().mockImplementation((...args) => console.log(...args)),
      info: vi.fn().mockImplementation((...args) => console.log(...args)),
      error: vi.fn().mockImplementation((...args) => console.error(...args)),
      warn: vi.fn().mockImplementation((...args) => console.warn(...args)),
      createLogger: vi.fn(),
    };
  });

  vscode.env = vscode.env || {};
  vscode.env.asExternalUri = vi.fn().mockImplementation(async (uri) => uri);
  const QuickPickItemKind = {
    Separator: -1,
    Default: 0,
  };
  vscode.QuickPickItemKind = QuickPickItemKind;
  vscode.window.createWebviewPanel = vi.fn().mockImplementation(() => {
    return {
      webview: {
        onDidReceiveMessage: vi.fn(),
        html: "",
      },
      onDidDispose: vi.fn(),
      dispose: vi.fn(),
    };
  });

  vscode.notebooks = vscode.notebooks || {};
  vscode.notebooks.createNotebookController = vi
    .fn()
    .mockImplementation((id, notebookType, label) => {
      const mockNotebookController: vscode.NotebookController = {
        id,
        notebookType,
        supportedLanguages: [],
        label,
        supportsExecutionOrder: false,
        createNotebookCellExecution: vi.fn(),
        executeHandler: vi.fn(),
        interruptHandler: vi.fn(),
        onDidChangeSelectedNotebooks: vi.fn(),
        updateNotebookAffinity: vi.fn(),
        dispose: vi.fn(),
      } satisfies vscode.NotebookController;
      return mockNotebookController;
    });

  vscode.notebooks.createRendererMessaging = vi.fn().mockReturnValue({
    postMessage: vi.fn().mockResolvedValue(true),
    onDidReceiveMessage: vi.fn().mockReturnValue({
      dispose: vi.fn(),
    }),
  });

  vscode.debug = vscode.debug || {};
  vscode.debug.registerDebugConfigurationProvider = vi.fn();
  vscode.debug.registerDebugAdapterDescriptorFactory = vi.fn().mockReturnValue({
    dispose: vi.fn(),
  });

  // Add missing data type constructors that VsCode service exports
  vscode.NotebookData = class NotebookData implements vscode.NotebookData {
    cells: Array<vscode.NotebookCellData>;
    constructor(cells: Array<vscode.NotebookCellData>) {
      this.cells = cells;
    }
  };

  vscode.NotebookCellData = class NotebookCellData
    implements vscode.NotebookCellData
  {
    kind: vscode.NotebookCellKind;
    value: string;
    languageId: string;
    constructor(
      kind: vscode.NotebookCellKind,
      value: string,
      languageId: string,
    ) {
      this.kind = kind;
      this.value = value;
      this.languageId = languageId;
    }
  };

  vscode.NotebookCellKind = {
    Markup: 1,
    Code: 2,
  };

  vscode.NotebookCellOutput = class NotebookCellOutput
    implements vscode.NotebookCellOutput
  {
    items: Array<vscode.NotebookCellOutputItem>;
    metadata: { [key: string]: unknown };
    constructor(
      items: Array<vscode.NotebookCellOutputItem>,
      metadata?: { [key: string]: unknown },
    ) {
      this.items = items;
      this.metadata = metadata ?? {};
    }
  };

  vscode.NotebookCellOutputItem = class NotebookCellOutputItem
    implements vscode.NotebookCellOutputItem
  {
    static text(value: string, mime?: string): NotebookCellOutputItem {
      return new NotebookCellOutputItem(
        new TextEncoder().encode(value),
        mime || "text/plain",
      );
    }
    static json(value: unknown, mime?: string): NotebookCellOutputItem {
      return new NotebookCellOutputItem(
        new TextEncoder().encode(JSON.stringify(value)),
        mime || "application/json",
      );
    }
    static stdout(value: string): NotebookCellOutputItem {
      return new NotebookCellOutputItem(
        new TextEncoder().encode(value),
        "application/vnd.code.notebook.stdout",
      );
    }
    static stderr(value: string): NotebookCellOutputItem {
      return new NotebookCellOutputItem(
        new TextEncoder().encode(value),
        "application/vnd.code.notebook.stderr",
      );
    }
    static error(value: Error): NotebookCellOutputItem {
      return new NotebookCellOutputItem(
        new TextEncoder().encode(
          JSON.stringify({
            name: value.name,
            message: value.message,
            stack: value.stack,
          }),
        ),
        "application/vnd.code.notebook.error",
      );
    }

    mime: string;
    data: Uint8Array;
    constructor(data: Uint8Array, mime: string) {
      this.data = data;
      this.mime = mime;
    }
  };

  vscode.EventEmitter = class EventEmitter<T>
    implements vscode.EventEmitter<T>
  {
    #listeners: Array<(e: T) => unknown> = [];
    event: vscode.Event<T> = (listener) => {
      this.#listeners.push(listener);
      return {
        dispose: () =>
          this.#listeners.splice(this.#listeners.indexOf(listener), 1),
      };
    };
    fire(data: T) {
      for (const listener of this.#listeners) {
        listener(data);
      }
    }
    dispose() {
      this.#listeners = [];
    }
  };

  vscode.DebugAdapterInlineImplementation = class DebugAdapterInlineImplementation
    implements vscode.DebugAdapterInlineImplementation
  {
    implementation: vscode.DebugAdapter;
    constructor(implementation: vscode.DebugAdapter) {
      this.implementation = implementation;
    }
  };

  // Add workspace properties using defineProperty for read-only properties
  // Add workspace properties
  Object.defineProperty(vscode.workspace, "notebookDocuments", {
    value: [],
    writable: false,
    configurable: true,
  });
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    value: [],
    writable: false,
    configurable: true,
  });

  // Add window properties
  vscode.window.activeNotebookEditor = undefined;

  // Add env.openExternal
  vscode.env.openExternal = vi.fn().mockResolvedValue(true);

  // Add commands.executeCommand
  vscode.commands = vscode.commands || {};
  vscode.commands.executeCommand = vi.fn().mockResolvedValue(undefined);

  // Add Uri.parse
  vscode.Uri = vscode.Uri || {};
  vscode.Uri.parse = vi.fn().mockImplementation((value) => ({
    scheme: "https",
    authority: "",
    path: value,
    query: "",
    fragment: "",
    fsPath: value,
    toString: () => value,
  }));

  return vscode;
}

vitest.afterAll(() => {
  for (const proc of openProcesses) {
    proc.kill();
  }
});
