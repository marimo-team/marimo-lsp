# Copyright 2026 Marimo. All rights reserved.

"""LSP-specific AppFileManager implementation."""

from __future__ import annotations

import pathlib
from typing import TYPE_CHECKING
from urllib.parse import unquote

from lsprotocol.types import NotebookDocument
from marimo._ast.app import App, InternalApp
from marimo._ast.cell import CellConfig
from marimo._messaging.notebook.document import NotebookCell
from marimo._messaging.notebook.outputs import CellOutputs
from marimo._types.ids import CellId_t
from pygls.uris import to_fs_path

from marimo_lsp.utils import (
    decode_cell_metadata,
    decode_notebook_document_metadata,
    find_text_document,
    normalize_cell_code,
)

if TYPE_CHECKING:
    from collections.abc import Generator

    import lsprotocol.types as lsp
    from lsprotocol.types import NotebookDocument
    from marimo._schemas.notebook import NotebookCellConfig
    from pygls.lsp.server import LanguageServer
    from pygls.workspace import Workspace

    from marimo_lsp.sessions import Session


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
            workspace=server.workspace,
            notebook_uri=notebook_uri,
            app=None,
        )
        self.header: str | None = None
        self.sync_header(server.workspace)

    def sync_header(self, workspace: Workspace) -> None:
        """Synchronize the notebook header used by saved sessions."""
        notebook = find_notebook_document(workspace, self._notebook_uri)
        self.header = decode_notebook_document_metadata(notebook).header

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

    def move(self, notebook_uri: str) -> None:
        """Update the URI after the backing notebook is renamed."""
        self._notebook_uri = notebook_uri


def find_notebook_document(
    workspace: Workspace, notebook_uri: str
) -> lsp.NotebookDocument:
    """Find a notebook document, handling percent-encoded URIs.

    VS Code may percent-encode the Windows drive letter colon in file URIs
    (e.g., ``file:///c%3A/...`` vs ``file:///c:/...``). This helper normalizes
    both the lookup URI and the stored keys so the document is found regardless
    of encoding.
    """
    doc = workspace.notebook_documents.get(notebook_uri)
    if doc is not None:
        return doc

    normalized = unquote(notebook_uri)
    for key, doc in workspace.notebook_documents.items():
        if unquote(key) == normalized:
            return doc

    raise KeyError(notebook_uri)


def _iter_notebook_cells(
    workspace: Workspace,
    notebook: NotebookDocument,
) -> Generator[tuple[CellId_t, str, str, NotebookCellConfig]]:
    """Yield (cell_id, code, name, config) for each valid cell in a notebook."""
    for cell in notebook.cells:
        meta = decode_cell_metadata(cell)
        if meta.marimo_runtime.stable_id is None:
            continue
        document = find_text_document(workspace, cell.document)
        source = (document.source or "") if document else ""
        language_id = (document.language_id if document else None) or "python"
        code = normalize_cell_code(language_id, source, meta.marimo.source_projections)
        yield (
            CellId_t(meta.marimo_runtime.stable_id),
            code,
            meta.marimo.name,
            meta.marimo.config,
        )


def sync_app_with_workspace(
    workspace: Workspace, notebook_uri: str, app: InternalApp | None
) -> InternalApp:
    """Sync workspace with InternalApp."""
    notebook = find_notebook_document(workspace, notebook_uri)

    metadata = decode_notebook_document_metadata(notebook)
    app_options = metadata.app_config
    if app is None:
        app = InternalApp(App(**app_options))

    app.update_config(app_options)

    cell_ids: list[CellId_t] = []
    codes: list[str] = []
    configs: list[CellConfig] = []
    names: list[str] = []

    for cell_id, code, name, config in _iter_notebook_cells(workspace, notebook):
        cell_ids.append(cell_id)
        codes.append(code)
        # Must be a CellConfig, not a dict: code mode reads attributes like
        # `config.column` off these (a dict raises AttributeError).
        configs.append(CellConfig.from_dict(dict(config)))
        names.append(name)

    return app.with_data(
        cell_ids=cell_ids,
        codes=codes,
        configs=configs,
        names=names,
    )


def _snapshot_notebook_cells(
    workspace: Workspace,
    notebook: NotebookDocument,
) -> tuple[NotebookCell, ...]:
    """Snapshot the LSP notebook for code mode."""
    return tuple(
        NotebookCell(
            id=cell_id,
            code=code,
            name=name,
            config=CellConfig.from_dict(dict(config)),
        )
        for cell_id, code, name, config in _iter_notebook_cells(workspace, notebook)
    )


def snapshot_for_scratchpad(
    workspace: Workspace,
    session: Session,
    notebook: NotebookDocument,
) -> tuple[tuple[NotebookCell, ...], CellOutputs]:
    """Snapshot the LSP notebook document's cells for code mode."""
    cells = _snapshot_notebook_cells(workspace, notebook)
    ids = [cell.id for cell in cells]
    cell_outputs = CellOutputs(
        output=session.session_view.get_cell_outputs(ids),
        console_outputs=session.session_view.get_cell_console_outputs(ids),
    )
    return cells, cell_outputs
