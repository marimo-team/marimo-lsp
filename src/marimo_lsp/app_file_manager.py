"""LSP-specific AppFileManager implementation."""

from __future__ import annotations

import pathlib
from typing import TYPE_CHECKING, Any

from lsprotocol.types import NotebookCellKind
from marimo._ast.app import App, InternalApp
from marimo._ast.cell import CellConfig
from marimo._types.ids import CellId_t
from pygls.uris import to_fs_path

if TYPE_CHECKING:
    from pygls.lsp.server import LanguageServer


class LspAppFileManager:
    """AppFileManager implementation for marimo LSP integration.

    This class provides a minimal AppFileManager interface that loads app state
    from LSP notebook documents instead of filesystem files.

    It _only_ implements the methods actually used by marimo's `Session` class, throwing
    `NotImplementedError` for file operations that don't make sense in an LSP context.
    """

    def __init__(self, *, server: LanguageServer, notebook_uri: str) -> None:
        self._server = server
        self._notebook_uri = notebook_uri
        self.app = self._load_app_from_notebook_document()

    @property
    def filename(self) -> str | None:
        """The notebook file name."""
        maybe_path = self.path
        if maybe_path:
            return pathlib.Path(maybe_path).name
        return None

    @property
    def path(self) -> str | None:
        """Return the notebook path.

        This is used by Session for caching and identification purposes.
        """
        return to_fs_path(self._notebook_uri)

    @property
    def is_notebook_named(self) -> bool:
        """Check if the notebook has a name.

        LSP notebooks always have a URI, so this always returns True.
        """
        return True

    def reload(self) -> set[CellId_t]:
        """Reload the app from the VS Code notebook document.

        This method is called by Session when it detects file changes.
        It reloads the app state from VS Code and returns the set of
        cell IDs that have changed.
        """
        prev_cell_manager = self.app.cell_manager
        self.app = self._load_app_from_notebook_document()

        # Find changed cells by comparing code content
        changed_cell_ids: set[CellId_t] = set()
        prev_codes = {
            cid: prev_cell_manager.get_cell_code(cid)
            for cid in prev_cell_manager.cell_ids()
        }

        for cell_id in self.app.cell_manager.cell_ids():
            if cell_id not in prev_codes or self.app.cell_manager.get_cell_code(
                cell_id
            ) != prev_codes.get(cell_id):
                changed_cell_ids.add(cell_id)

        return changed_cell_ids

    def _load_app_from_notebook_document(self) -> InternalApp:
        """Load the app from the LSP notebook document.

        This method extracts cell content and metadata from the LSP
        notebook document and creates an InternalApp instance.
        """
        notebook = self._server.workspace.notebook_documents.get(self._notebook_uri)
        assert notebook is not None, f"No notebook document found for {self.filename}"

        app_config = (notebook.metadata or {}).get("app", {})

        app = InternalApp(App(**app_config))

        for cell in notebook.cells:
            if cell.kind == NotebookCellKind.Code:
                cell_doc = self._server.workspace.get_text_document(cell.document)
                cell_metadata = cell.metadata or {}
                app.cell_manager.register_cell(
                    cell_id=CellId_t(cell.document),
                    code=cell_doc.source,
                    name=cell_metadata.get("name", "_"),
                    config=CellConfig.from_dict(cell_metadata.get("config", {})),
                )

        return app

    def save(self, request: object) -> str:
        """Save is not supported in LSP."""
        msg = "Save not supported in LSP mode. LSP handles file operations."
        raise NotImplementedError(msg)

    def rename(self, new_filename: str) -> None:
        """Rename is not supported in LSP."""
        msg = "Rename not supported in LSP mode. LSP handles file operations."
        raise NotImplementedError(msg)

    def save_app_config(self, config: dict[str, Any]) -> str:
        """Save app config is not supported in LSP."""
        msg = "Save app config not supported in LSP mode. LSP handles file operations."
        raise NotImplementedError(msg)

    def to_code(self) -> str:
        """Export to Python code is not supported in LSP."""
        msg = "Export not supported in LSP mode. Notebook serializer handles document."
        raise NotImplementedError(msg)

    def read_file(self) -> str:
        """Read raw file content is not supported in LSP mode."""
        msg = "Read raw file not supported in LSP mode. LSP handles file operations."
        raise NotImplementedError(msg)

    def read_layout_config(self) -> object | None:
        """Read layout configuration."""
        return None

    def read_css_file(self) -> str | None:
        """Read CSS file content.

        Custom CSS is not applicable in LSP.
        """
        return None

    def read_html_head_file(self) -> str | None:
        """Read HTML head file content.

        Custom HTML is not applicable in LSP.
        """
        return None
