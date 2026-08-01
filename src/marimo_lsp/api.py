# Copyright 2026 Marimo. All rights reserved.

"""Handlers for marimo.api commands."""

from __future__ import annotations

import dataclasses
import json
from typing import TYPE_CHECKING, cast

import msgspec
from marimo._convert.converters import MarimoConvert
from marimo._export.exporter import Exporter
from marimo._export.requests import HTMLExportRequest, IPYNBExportRequest
from marimo._export.serialization import serialize_notebook_snapshot
from marimo._runtime.commands import (
    ExecuteScratchpadCommand,
    InvokeFunctionCommand,
)
from marimo._runtime.packages.package_managers import create_package_manager
from marimo._schemas.export import ExportAsHTMLRequest, to_html_export_options
from marimo._schemas.export_options import IPYNBExportOptions
from marimo._schemas.serialization import NotebookSerialization
from marimo._session.requests import InstantiateNotebookRequest
from marimo._session.state.serialize import serialize_session_view
from marimo._utils.parse_dataclass import parse_raw
from pygls.uris import to_fs_path

from marimo_lsp.app_file_manager import find_notebook_document, snapshot_for_scratchpad
from marimo_lsp.loggers import get_logger
from marimo_lsp.models import (
    CloseSessionRequest,
    DeleteCellRequest,
    DependencyTreeRequest,
    DeserializeRequest,
    ExecuteCellsRequest,
    ExecuteScratchRequest,
    ExportAsIpynbRequest,
    GetConfigurationRequest,
    InterruptRequest,
    ListPackagesRequest,
    ModelRequest,
    NotebookCommand,
    PackageCommand,
    ScriptSource,
    SerializeRequest,
    SessionCommand,
    SetDisplayThemeRequest,
    StdinRequest,
    UpdateConfigurationRequest,
    UpdateUIElementRequest,
    VenvSource,
)
from marimo_lsp.package_manager import LspPackageManager

if TYPE_CHECKING:
    from marimo._config.config import (
        DisplayConfig,
        MarimoConfig,
        PartialMarimoConfig,
        SharingConfig,
    )
    from pygls.lsp.server import LanguageServer

    from marimo_lsp.sessions import Sessions


__all__ = ["handle_api_command"]

logger = get_logger()


def _get_display_config(config: MarimoConfig) -> DisplayConfig:
    """Extract the display config from a MarimoConfig.

    Workaround for ty not resolving the 'display' key on MarimoConfig.
    """
    return cast("DisplayConfig", config.get("display", {}))


async def run(
    sessions: Sessions,
    args: SessionCommand[ExecuteCellsRequest],
):
    logger.info(f"run for {args.notebook_uri}")
    session = sessions.start(args.notebook_uri, args.executable)

    session.instantiate(
        InstantiateNotebookRequest(auto_run=False, object_ids=[], values=[]),
        http_request=None,
    )
    session.put_control_request(args.inner.as_command(), from_consumer_id=None)
    logger.info(f"Execution request sent for {args.notebook_uri}")


async def set_ui_element_value(
    sessions: Sessions,
    args: NotebookCommand[UpdateUIElementRequest],
):
    logger.info(f"set_ui_element_value for {args.notebook_uri}")
    session = sessions.get(args.notebook_uri)
    assert session, f"No session in workspace for {args.notebook_uri}"
    session.put_control_request(args.inner.as_command(), from_consumer_id=None)


async def set_model_value(
    sessions: Sessions,
    args: NotebookCommand[ModelRequest],
):
    logger.info(f"set_model_value for {args.notebook_uri}")
    session = sessions.get(args.notebook_uri)
    assert session, f"No session in workspace for {args.notebook_uri}"
    session.put_control_request(args.inner.as_command(), from_consumer_id=None)


async def function_call_request(
    sessions: Sessions,
    args: NotebookCommand[InvokeFunctionCommand],
):
    logger.info(f"function_call_request for {args.notebook_uri}")
    session = sessions.get(args.notebook_uri)
    assert session, f"No session in workspace for {args.notebook_uri}"
    session.put_control_request(args.inner, from_consumer_id=None)


async def interrupt(
    sessions: Sessions,
    args: NotebookCommand[InterruptRequest],
):
    logger.info(f"interrupt for {args.notebook_uri}")
    session = sessions.get(args.notebook_uri)
    if session:
        session.try_interrupt()
        logger.info(f"Interrupt request sent for {args.notebook_uri}")
    else:
        logger.warning(f"No session found for {args.notebook_uri}")


async def delete_cell(
    sessions: Sessions,
    args: NotebookCommand[DeleteCellRequest],
):
    logger.info(f"delete_cell for {args.notebook_uri}")
    session = sessions.get(args.notebook_uri)
    if session:
        session.put_control_request(args.inner.as_command(), from_consumer_id=None)
        logger.info(f"Delete cell request sent for {args.notebook_uri}")
    else:
        logger.warning(f"No session found for {args.notebook_uri}")


async def send_stdin(
    sessions: Sessions,
    args: NotebookCommand[StdinRequest],
):
    logger.info(f"send_stdin for {args.notebook_uri}")
    session = sessions.get(args.notebook_uri)
    if session:
        session.put_input(args.inner.text)
    else:
        logger.warning(f"No session found for {args.notebook_uri}")


async def close_session(
    sessions: Sessions,
    args: NotebookCommand[CloseSessionRequest],
):
    logger.info(f"close_session for {args.notebook_uri}")
    sessions.close(args.notebook_uri)


async def execute_scratch(
    ls: LanguageServer,
    sessions: Sessions,
    args: SessionCommand[ExecuteScratchRequest],
):
    """Execute code in the scratchpad (isolated from dependency graph).

    Populates the document + output snapshot on the command so that
    ``marimo._code_mode.get_context()`` can bind inside the kernel. Cells come
    from the LSP notebook document (id-aligned with VS Code);
    outputs come from the session view.

    Creates the session on demand when none exists, like :func:`run`.
    """
    logger.info(f"execute_scratch for {args.notebook_uri}")
    try:
        notebook = find_notebook_document(ls.workspace, args.notebook_uri)
    except KeyError:
        logger.warning(
            f"No notebook document found for {args.notebook_uri}; "
            "skipping scratchpad execution"
        )
        return

    session = sessions.start(args.notebook_uri, args.executable)

    session.instantiate(
        InstantiateNotebookRequest(auto_run=False, object_ids=[], values=[]),
        http_request=None,
    )

    notebook_cells, cell_outputs = snapshot_for_scratchpad(
        workspace=ls.workspace,
        session=session,
        notebook=notebook,
    )

    session.put_control_request(
        ExecuteScratchpadCommand(
            code=args.inner.code,
            run_id=args.inner.run_id,
            notebook_cells=notebook_cells,
            cell_outputs=cell_outputs,
        ),
        from_consumer_id=None,
    )
    logger.info(f"Scratchpad execution request sent for {args.notebook_uri}")


async def get_package_list(
    args: PackageCommand[ListPackagesRequest],
):
    logger.info(f"get_package_list for {args.notebook_uri}")
    package_manager = _package_manager_for(args.source)
    if not package_manager.is_manager_installed():
        logger.warning(f"Package manager not installed for {args.notebook_uri}")
        return {"packages": []}

    if isinstance(args.source, ScriptSource):
        # No bound venv to `uv pip list` against; flatten `uv tree --script`
        # instead. Falling through to the venv path here would list packages
        # from whatever Python uv defaulted to (the LSP's own env), not the
        # script's.
        filename = _script_filename(args.notebook_uri)
        if filename is None:
            return {"packages": []}
        tree = package_manager.dependency_tree(filename)
        return msgspec.to_builtins({"packages": _flatten_tree(tree)})

    packages = package_manager.list_packages()
    return msgspec.to_builtins({"packages": packages})


async def get_dependency_tree(
    args: PackageCommand[DependencyTreeRequest],
):
    logger.info(f"get_dependency_tree for {args.notebook_uri}")
    package_manager = _package_manager_for(args.source)

    if isinstance(args.source, ScriptSource):
        # PEP 723 sandbox script: derive the filename from the notebook URI
        # and let `uv tree --script <file>` resolve the env.
        filename = _script_filename(args.notebook_uri)
        if filename is None:
            return {"tree": None}
        tree = package_manager.dependency_tree(filename)
    else:
        tree = package_manager.dependency_tree()

    return msgspec.to_builtins({"tree": tree})


def _script_filename(notebook_uri: str) -> str | None:
    """Resolve a `file://` URI to a filesystem path; warn on anything else.

    Non-file URIs (e.g. `untitled:`, `vscode-notebook-cell:`) can't drive
    `uv tree --script`. Surfacing them as `None` keeps the script branch
    fail-closed instead of silently degrading to the project-aware
    `uv tree` (which is the wrong env entirely).
    """
    filename = to_fs_path(notebook_uri)
    if filename is None:
        logger.warning(
            "Cannot resolve script filename from non-file URI",
            extra={"notebook_uri": notebook_uri},
        )
    return filename


def _flatten_tree(tree: object) -> list[dict[str, str]]:
    """Walk a `uv tree` result and return a deduplicated list of packages.

    Mirrors marimo's own `UvPackageManager.list_packages` flattening so that
    the script-mode `get-package-list` response shape matches the venv-mode
    `uv pip list` response.
    """
    if tree is None:
        return []
    seen: set[str] = set()
    packages: list[dict[str, str]] = []
    stack: list[object] = list(getattr(tree, "dependencies", []))
    while stack:
        node = stack.pop()
        name = getattr(node, "name", None)
        if not isinstance(name, str) or name in seen:
            continue
        seen.add(name)
        version = getattr(node, "version", None) or ""
        packages.append({"name": name, "version": version})
        stack.extend(getattr(node, "dependencies", []))
    return sorted(packages, key=lambda p: p["name"])


def _package_manager_for(source: VenvSource | ScriptSource) -> LspPackageManager:
    """Build a package manager for the given environment source.

    We pin the underlying tool to `uv` for both variants today: `uv pip list`
    works against any python env, and `uv tree --script` is the only way to
    introspect a PEP 723 script's deps. A future server-side change can pick
    the user's preferred manager for venv mode without a wire-protocol change.
    """
    venv_location = source.executable if isinstance(source, VenvSource) else None
    return LspPackageManager(
        delegate=create_package_manager("uv"),
        venv_location=venv_location,
    )


async def serialize(args: SerializeRequest):
    ir = parse_raw(args.notebook, cls=NotebookSerialization)
    return {"source": MarimoConvert.from_ir(ir).to_py()}


async def deserialize(args: DeserializeRequest):
    converter = MarimoConvert.from_py(args.source)
    ir = converter.to_ir()

    # The `_ast` field on each `CellDef` holds a parsed Python AST, which isn't
    # serializable. Since the AST isn't used on the other side of the wire,
    # we can safely drop it before serialization.
    for cell in ir.cells:
        cell._ast = None  # noqa: SLF001

    return dataclasses.asdict(ir)


async def get_configuration(
    sessions: Sessions,
    args: NotebookCommand[GetConfigurationRequest],
):
    """Get the current marimo configuration."""
    session = sessions.get(args.notebook_uri)
    if not session:
        logger.warning(f"No session found for {args.notebook_uri}")
        return {"config": {}}

    config = session.get_config()
    return msgspec.to_builtins({"config": config})


async def update_configuration(
    sessions: Sessions,
    args: NotebookCommand[UpdateConfigurationRequest],
):
    """Update the marimo user configuration."""
    session = sessions.get(args.notebook_uri)
    if not session:
        logger.warning(f"No session found for {args.notebook_uri}")
        return {"success": False, "error": "No session found"}

    try:
        updated_config = session.save_config(
            cast("PartialMarimoConfig", args.inner.config),
        )

        return msgspec.to_builtins({"success": True, "config": updated_config})
    except Exception as e:
        logger.exception(f"Error updating configuration for {args.notebook_uri}")
        return {"success": False, "error": str(e)}


async def set_display_theme(
    sessions: Sessions,
    args: SetDisplayThemeRequest,
):
    """Set the display theme in all kernels without persisting to disk."""
    for session in sessions:
        config = session.get_config(hide_secrets=False)
        display = _get_display_config(config)
        updated = cast(
            "MarimoConfig", {**config, "display": {**display, "theme": args.theme}}
        )
        session.update_runtime_config(updated)
    return {"success": True}


async def export_as_html(
    sessions: Sessions,
    args: NotebookCommand[ExportAsHTMLRequest],
):
    """Export the notebook as HTML with current outputs."""
    logger.info(f"export_as_html for {args.notebook_uri}")
    session = sessions.get(args.notebook_uri)
    assert session, f"No session in workspace for {args.notebook_uri}"

    # Export the notebook with current outputs using the Exporter
    app = session.app
    config = session.get_config()
    html, _filename = Exporter().export_as_html(
        HTMLExportRequest(
            filename=session.filename,
            app_code=app.to_py(),
            app_config=app.config,
            snapshot=serialize_notebook_snapshot(
                app,
                session.session_view,
                drop_virtual_file_outputs=False,
                include_model_notifications=True,
            ),
            display_config=_get_display_config(config),
            options=to_html_export_options(args.inner),
            sharing_config=cast("SharingConfig | None", config.get("sharing")),
        )
    )

    return html


async def export_as_ipynb(
    sessions: Sessions,
    args: NotebookCommand[ExportAsIpynbRequest],
) -> str:
    """Export the notebook as ipynb with current outputs."""
    logger.info(f"export_as_ipynb for {args.notebook_uri}")
    session = sessions.get(args.notebook_uri)
    assert session, f"No session in workspace for {args.notebook_uri}"

    ipynb_str = Exporter().export_as_ipynb(
        IPYNBExportRequest(
            app=session.app,
            options=IPYNBExportOptions(sort_mode="top-down"),
            session_view=session.session_view,
        )
    )

    # inject 'session.json' under top-level notebook metadata
    # -> metadata.marimo.session
    ipynb = json.loads(ipynb_str)
    session_data = serialize_session_view(
        session.session_view,
        cell_ids=session.app.cell_manager.cell_ids(),
        drop_virtual_file_outputs=True,
    )
    ipynb.setdefault("metadata", {}).setdefault("marimo", {})["session"] = session_data
    return json.dumps(ipynb)


async def handle_api_command(  # noqa: C901, PLR0911, PLR0912
    ls: LanguageServer, sessions: Sessions, method: str, params: dict
) -> object:
    """Unified API endpoint for all marimo internal methods."""
    if method == "execute-cells":
        return await run(
            sessions,
            msgspec.convert(params, type=SessionCommand[ExecuteCellsRequest]),
        )

    if method == "send-stdin":
        return await send_stdin(
            sessions, msgspec.convert(params, type=NotebookCommand[StdinRequest])
        )

    if method == "interrupt":
        return await interrupt(
            sessions, msgspec.convert(params, type=NotebookCommand[InterruptRequest])
        )

    if method == "delete-cell":
        return await delete_cell(
            sessions, msgspec.convert(params, type=NotebookCommand[DeleteCellRequest])
        )

    if method == "update-ui-element":
        return await set_ui_element_value(
            sessions,
            msgspec.convert(params, type=NotebookCommand[UpdateUIElementRequest]),
        )

    if method == "set-model-value":
        return await set_model_value(
            sessions,
            msgspec.convert(params, type=NotebookCommand[ModelRequest]),
        )

    if method == "invoke-function":
        return await function_call_request(
            sessions,
            msgspec.convert(params, type=NotebookCommand[InvokeFunctionCommand]),
        )

    if method == "close-session":
        return await close_session(
            sessions,
            msgspec.convert(params, type=NotebookCommand[CloseSessionRequest]),
        )

    if method == "serialize":
        return await serialize(msgspec.convert(params, type=SerializeRequest))

    if method == "deserialize":
        return await deserialize(msgspec.convert(params, type=DeserializeRequest))

    if method == "get-package-list":
        return await get_package_list(
            msgspec.convert(params, type=PackageCommand[ListPackagesRequest]),
        )

    if method == "get-dependency-tree":
        return await get_dependency_tree(
            msgspec.convert(params, type=PackageCommand[DependencyTreeRequest]),
        )

    if method == "get-configuration":
        return await get_configuration(
            sessions,
            msgspec.convert(params, type=NotebookCommand[GetConfigurationRequest]),
        )

    if method == "update-configuration":
        return await update_configuration(
            sessions,
            msgspec.convert(params, type=NotebookCommand[UpdateConfigurationRequest]),
        )

    if method == "set-display-theme":
        return await set_display_theme(
            sessions,
            msgspec.convert(params, type=SetDisplayThemeRequest),
        )

    if method == "export-as-html":
        return await export_as_html(
            sessions,
            msgspec.convert(params, type=NotebookCommand[ExportAsHTMLRequest]),
        )

    if method == "export-as-ipynb":
        return await export_as_ipynb(
            sessions,
            msgspec.convert(params, type=NotebookCommand[ExportAsIpynbRequest]),
        )

    if method == "execute-scratchpad":
        return await execute_scratch(
            ls,
            sessions,
            msgspec.convert(params, type=SessionCommand[ExecuteScratchRequest]),
        )

    logger.warning(f"Unknown API method: {method}")
    raise ValueError(method)
