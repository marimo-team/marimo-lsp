"""LSP-specific AppFileManager implementation."""

from __future__ import annotations

import pathlib
from typing import TYPE_CHECKING, Any

from marimo._ast.app import App, InternalApp
from marimo._types.ids import CellId_t
from pygls.uris import to_fs_path

if TYPE_CHECKING:
    from pygls.lsp.server import LanguageServer
    from pygls.workspace import Workspace


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
        self.app = sync_app_with_workspace(
            workspace=server.workspace, notebook_uri=notebook_uri, app=None
        )

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

    def reload(self) -> set[CellId_t]:
        """Relad file is not supported in LSP mode."""
        msg = "Reload file si not supported in LSP mode. LSP handles file operations."
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


def sync_app_with_workspace(
    workspace: Workspace, notebook_uri: str, app: InternalApp | None
) -> InternalApp:
    """Sync workspace with InternalApp."""
    notebook = workspace.notebook_documents[notebook_uri]

    app_config = notebook.metadata or {}
    if app is None:
        app = InternalApp(App(**app_config))

    app.update_config(app_config)

    cell_ids: list[CellId_t] = []
    codes = []
    configs = []
    names: list[str] = []

    for cell in notebook.cells:
        # Extract cell ID from document URI fragment (e.g., "file:///test.py#cell1" -> "cell1")
        cell_id = cell.document.split("#")[-1] if "#" in cell.document else cell.document
        cell_ids.append(CellId_t(cell_id))
        codes.append(workspace.text_documents.get(cell.document) or "")
        configs.append((cell.metadata or {}).get("config", {}))
        names.append((cell.metadata or {}).get("name", "_"))

    return app.with_data(
        cell_ids=cell_ids,
        codes=codes,
        configs=configs,
        names=names,
    )
