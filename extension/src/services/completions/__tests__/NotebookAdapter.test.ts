import { describe, expect, it } from "@effect/vitest";
import type * as vscode from "vscode";
import type * as lsp from "vscode-languageclient/node";
import {
  createNotebookCell,
  createTestNotebookDocument,
  Uri,
} from "../../../__mocks__/TestVsCode.ts";
import {
  extendNotebookCellLanguages,
  NotebookAdapter,
} from "../NotebookSyncService.ts";

describe("NotebookAdapter (with .ipynb)", () => {
  const adapter = new NotebookAdapter("mo-python", (uri) =>
    uri.with({ path: `${uri.path}.ipynb` }),
  );

  describe("notebookDocument", () => {
    it("appends .ipynb to notebook URI path", () => {
      const uri = Uri.file("/workspace/notebook_mo.py");
      const wrapped = adapter.notebookDocument({ uri });

      expect(wrapped.uri.path).toBe("/workspace/notebook_mo.py.ipynb");
    });

    it("preserves other URI components", () => {
      const uri = Uri.from({
        scheme: "vscode-notebook",
        authority: "",
        path: "/workspace/test.py",
        query: "foo=bar",
        fragment: "cell1",
      });

      const wrapped = adapter.notebookDocument({ uri });

      expect(wrapped.uri.scheme).toBe("vscode-notebook");
      expect(wrapped.uri.query).toBe("foo=bar");
      expect(wrapped.uri.fragment).toBe("cell1");
      expect(wrapped.uri.path).toBe("/workspace/test.py.ipynb");
    });
  });

  describe("document", () => {
    it("normalizes mo-python to python", () => {
      const doc = {
        languageId: "mo-python",
        uri: Uri.file("/test.py"),
      };
      const wrapped = adapter.document(doc);

      expect(wrapped.languageId).toBe("python");
    });

    it("leaves other language IDs unchanged", () => {
      const doc = { languageId: "sql", uri: Uri.file("/test.sql") };
      const wrapped = adapter.document(doc);

      expect(wrapped.languageId).toBe("sql");
    });

    it("does not modify the document URI", () => {
      const uri = Uri.file("/workspace/cell.py");
      const doc = {
        languageId: "mo-python",
        uri,
      } as vscode.TextDocument;

      const wrapped = adapter.document(doc);

      expect(wrapped.uri.path).toBe("/workspace/cell.py");
    });
  });

  describe("cell", () => {
    it("transforms notebook URI and cell language ID", () => {
      const notebookUri = Uri.file("/workspace/notebook_mo.py");
      const notebook = createTestNotebookDocument(notebookUri);
      const cell = createNotebookCell(
        notebook,
        { kind: 2, value: "x = 1", languageId: "mo-python" },
        0,
      );

      const wrapped = adapter.cell(cell);

      expect(wrapped.notebook.uri.path).toBe("/workspace/notebook_mo.py.ipynb");
      expect(wrapped.document.languageId).toBe("python");
    });
  });

  describe("cellsEvent", () => {
    it("returns undefined for undefined input", () => {
      expect(adapter.cellsEvent(undefined)).toBeUndefined();
    });

    it("transforms textContent documents", () => {
      const doc = { languageId: "mo-python", uri: Uri.file("/test.py") };
      const result = adapter.cellsEvent({
        textContent: [{ document: doc } as vscode.TextDocumentChangeEvent],
      });

      expect(result?.textContent?.[0].document.languageId).toBe("python");
    });

    it("transforms data cells", () => {
      const notebookUri = Uri.file("/workspace/notebook_mo.py");
      const notebook = createTestNotebookDocument(notebookUri);
      const cell = createNotebookCell(
        notebook,
        { kind: 2, value: "x = 1", languageId: "mo-python" },
        0,
      );

      const result = adapter.cellsEvent({ data: [cell] });

      expect(result?.data?.[0].notebook.uri.path).toBe(
        "/workspace/notebook_mo.py.ipynb",
      );
      expect(result?.data?.[0].document.languageId).toBe("python");
    });

    it("transforms structure cells", () => {
      const notebookUri = Uri.file("/workspace/notebook_mo.py");
      const notebook = createTestNotebookDocument(notebookUri);
      const cell = createNotebookCell(
        notebook,
        { kind: 2, value: "x = 1", languageId: "mo-python" },
        0,
      );

      const result = adapter.cellsEvent({
        structure: {
          array: { start: 0, deleteCount: 0, cells: [cell] },
          didOpen: [cell],
          didClose: [cell],
        },
      });

      expect(result?.structure?.array.cells?.[0].document.languageId).toBe(
        "python",
      );
      expect(result?.structure?.didOpen?.[0].document.languageId).toBe(
        "python",
      );
      expect(result?.structure?.didClose?.[0].document.languageId).toBe(
        "python",
      );
    });
  });
});

describe("NotebookAdapter (without .ipynb)", () => {
  const adapter = new NotebookAdapter("mo-python");

  describe("notebookDocument", () => {
    it("does not append .ipynb to notebook URI path", () => {
      const wrapped = adapter.notebookDocument({
        uri: Uri.file("/workspace/notebook_mo.py"),
      });

      expect(wrapped.uri.path).toBe("/workspace/notebook_mo.py");
    });

    it("preserves other URI components", () => {
      const uri = Uri.from({
        scheme: "vscode-notebook",
        authority: "",
        path: "/workspace/test.py",
        query: "foo=bar",
        fragment: "cell1",
      });

      const wrapped = adapter.notebookDocument({ uri });

      expect(wrapped.uri.scheme).toBe("vscode-notebook");
      expect(wrapped.uri.query).toBe("foo=bar");
      expect(wrapped.uri.fragment).toBe("cell1");
      expect(wrapped.uri.path).toBe("/workspace/test.py");
    });
  });

  describe("document", () => {
    it("normalizes mo-python to python", () => {
      const doc = { languageId: "mo-python", uri: Uri.file("/test.py") };
      const wrapped = adapter.document(doc);

      expect(wrapped.languageId).toBe("python");
    });

    it("leaves other language IDs unchanged", () => {
      const doc = { languageId: "sql", uri: Uri.file("/test.sql") };
      const wrapped = adapter.document(doc);

      expect(wrapped.languageId).toBe("sql");
    });

    it("does not modify the document URI", () => {
      const uri = Uri.file("/workspace/cell.py");
      const doc = { languageId: "mo-python", uri };
      const wrapped = adapter.document(doc);

      expect(wrapped.uri.path).toBe("/workspace/cell.py");
    });
  });

  describe("cell", () => {
    it("transforms notebook URI and cell language ID", () => {
      const notebookUri = Uri.file("/workspace/notebook_mo.py");
      const notebook = createTestNotebookDocument(notebookUri);
      const cell = createNotebookCell(
        notebook,
        { kind: 2, value: "x = 1", languageId: "mo-python" },
        0,
      );

      const wrapped = adapter.cell(cell);

      expect(wrapped.notebook.uri.path).toBe("/workspace/notebook_mo.py");
      expect(wrapped.document.languageId).toBe("python");
    });
  });

  describe("cellsEvent", () => {
    it("returns undefined for undefined input", () => {
      expect(adapter.cellsEvent(undefined)).toBeUndefined();
    });

    it("transforms textContent documents", () => {
      const doc = { languageId: "mo-python", uri: Uri.file("/test.py") };

      const result = adapter.cellsEvent({
        textContent: [{ document: doc } as vscode.TextDocumentChangeEvent],
      });

      expect(result?.textContent?.[0].document.languageId).toBe("python");
    });

    it("transforms data cells", () => {
      const notebookUri = Uri.file("/workspace/notebook_mo.py");
      const notebook = createTestNotebookDocument(notebookUri);
      const cell = createNotebookCell(
        notebook,
        { kind: 2, value: "x = 1", languageId: "mo-python" },
        0,
      );

      const result = adapter.cellsEvent({ data: [cell] });

      expect(result?.data?.[0].notebook.uri.path).toBe(
        "/workspace/notebook_mo.py",
      );
      expect(result?.data?.[0].document.languageId).toBe("python");
    });

    it("transforms structure cells", () => {
      const notebookUri = Uri.file("/workspace/notebook_mo.py");
      const notebook = createTestNotebookDocument(notebookUri);
      const cell = createNotebookCell(
        notebook,
        { kind: 2, value: "x = 1", languageId: "mo-python" },
        0,
      );

      const result = adapter.cellsEvent({
        structure: {
          array: { start: 0, deleteCount: 0, cells: [cell] },
          didOpen: [cell],
          didClose: [cell],
        },
      });

      expect(result?.structure?.array.cells?.[0].document.languageId).toBe(
        "python",
      );
      expect(result?.structure?.didOpen?.[0].document.languageId).toBe(
        "python",
      );
      expect(result?.structure?.didClose?.[0].document.languageId).toBe(
        "python",
      );
    });
  });
});

describe("extendNotebookCellLanguages", () => {
  it("adds language to notebook selector cells", () => {
    const capabilities: lsp.ServerCapabilities = {
      notebookDocumentSync: {
        notebookSelector: [
          {
            notebook: { notebookType: "jupyter-notebook" },
            cells: [{ language: "python" }],
          },
        ],
      },
    };

    const transform = extendNotebookCellLanguages("mo-python");
    const result = transform(capabilities);

    expect(result?.notebookDocumentSync?.notebookSelector?.[0]?.cells).toEqual([
      { language: "python" },
      { language: "mo-python" },
    ]);
  });

  it("handles multiple selectors", () => {
    const capabilities: lsp.ServerCapabilities = {
      notebookDocumentSync: {
        notebookSelector: [
          {
            notebook: { notebookType: "jupyter-notebook" },
            cells: [{ language: "python" }],
          },
          {
            notebook: { notebookType: "marimo-notebook" },
            cells: [{ language: "python" }],
          },
        ],
      },
    };

    const transform = extendNotebookCellLanguages("mo-python");
    const result = transform(capabilities);

    const sync = result.notebookDocumentSync;
    if (sync && "notebookSelector" in sync) {
      expect(sync.notebookSelector[0].cells).toContainEqual({
        language: "mo-python",
      });
      expect(sync.notebookSelector[1].cells).toContainEqual({
        language: "mo-python",
      });
    }
  });

  it("handles missing notebookDocumentSync", () => {
    const capabilities: lsp.ServerCapabilities = {};

    const transform = extendNotebookCellLanguages("mo-python");
    const result = transform(capabilities);

    expect(result.notebookDocumentSync).toBeUndefined();
  });

  it("handles selector without cells", () => {
    const capabilities: lsp.ServerCapabilities = {
      notebookDocumentSync: {
        notebookSelector: [
          {
            notebook: { notebookType: "jupyter-notebook" },
          },
        ],
      },
    };

    const transform = extendNotebookCellLanguages("mo-python");
    const result = transform(capabilities);

    // Should not throw, just return as-is
    expect(result.notebookDocumentSync).toBeDefined();
  });
});
