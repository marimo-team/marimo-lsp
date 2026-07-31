# Copyright 2026 Marimo. All rights reserved.

"""Handlers for marimo.api commands."""

from __future__ import annotations

import dataclasses
import json
import typing
from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:
    from collections.abc import Callable

import msgspec
from marimo._config.config import DEFAULT_CONFIG
from marimo._convert.converters import MarimoConvert
from marimo._export.exporter import Exporter
from marimo._export.requests import HTMLExportRequest, IPYNBExportRequest
from marimo._export.serialization import serialize_notebook_snapshot
from marimo._runtime.commands import (
    ExecuteScratchpadCommand,
    InvokeFunctionCommand,
)
from marimo._runtime.packages.package_manager import PackageDescription
from marimo._runtime.packages.package_managers import create_package_manager
from marimo._schemas.export import ExportAsHTMLRequest, to_html_export_options
from marimo._schemas.export_options import IPYNBExportOptions
from marimo._schemas.serialization import NotebookSerialization
from marimo._session.requests import InstantiateNotebookRequest
from marimo._session.state.serialize import serialize_session_view
from marimo._utils.parse_dataclass import parse_raw
from pygls.uris import to_fs_path
from typing_extensions import TypeForm

from marimo_lsp.app_file_manager import find_notebook_document, snapshot_for_scratchpad
from marimo_lsp.loggers import get_logger
from marimo_lsp.models import (
    CloseSessionRequest,
    DeleteCellRequest,
    DependencyTreeRequest,
    DependencyTreeResponse,
    DeserializeRequest,
    ExecuteCellsRequest,
    ExecuteScratchRequest,
    ExportAsIpynbRequest,
    GetConfigurationRequest,
    GetConfigurationResponse,
    InterruptRequest,
    ListPackagesRequest,
    ListPackagesResponse,
    ModelRequest,
    NotebookCommand,
    PackageCommand,
    ScriptSource,
    SerializeRequest,
    SerializeResponse,
    SessionCommand,
    SetDisplayThemeRequest,
    SetDisplayThemeResponse,
    StdinRequest,
    UpdateConfigurationRequest,
    UpdateConfigurationResponse,
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


__all__ = ["API_METHODS", "ApiMethod", "handle_api_command"]

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
) -> ListPackagesResponse:
    logger.info(f"get_package_list for {args.notebook_uri}")
    package_manager = _package_manager_for(args.source)
    if not package_manager.is_manager_installed():
        logger.warning(f"Package manager not installed for {args.notebook_uri}")
        return ListPackagesResponse(packages=[])

    if isinstance(args.source, ScriptSource):
        # No bound venv to `uv pip list` against; flatten `uv tree --script`
        # instead. Falling through to the venv path here would list packages
        # from whatever Python uv defaulted to (the LSP's own env), not the
        # script's.
        filename = _script_filename(args.notebook_uri)
        if filename is None:
            return ListPackagesResponse(packages=[])
        tree = package_manager.dependency_tree(filename)
        return ListPackagesResponse(packages=_flatten_tree(tree))

    return ListPackagesResponse(packages=package_manager.list_packages())


async def get_dependency_tree(
    args: PackageCommand[DependencyTreeRequest],
) -> DependencyTreeResponse:
    logger.info(f"get_dependency_tree for {args.notebook_uri}")
    package_manager = _package_manager_for(args.source)

    if isinstance(args.source, ScriptSource):
        # PEP 723 sandbox script: derive the filename from the notebook URI
        # and let `uv tree --script <file>` resolve the env.
        filename = _script_filename(args.notebook_uri)
        if filename is None:
            return DependencyTreeResponse(tree=None)
        tree = package_manager.dependency_tree(filename)
    else:
        tree = package_manager.dependency_tree()

    return DependencyTreeResponse(tree=tree)


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


def _flatten_tree(tree: object) -> list[PackageDescription]:
    """Walk a `uv tree` result and return a deduplicated list of packages.

    Mirrors marimo's own `UvPackageManager.list_packages` flattening so that
    the script-mode `get-package-list` response shape matches the venv-mode
    `uv pip list` response.
    """
    if tree is None:
        return []
    seen: set[str] = set()
    packages: list[PackageDescription] = []
    stack: list[object] = list(getattr(tree, "dependencies", []))
    while stack:
        node = stack.pop()
        name = getattr(node, "name", None)
        if not isinstance(name, str) or name in seen:
            continue
        seen.add(name)
        version = getattr(node, "version", None) or ""
        packages.append(PackageDescription(name=name, version=version))
        stack.extend(getattr(node, "dependencies", []))
    return sorted(packages, key=lambda p: p.name)


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


async def serialize(args: SerializeRequest) -> SerializeResponse:
    ir = parse_raw(args.notebook, cls=NotebookSerialization)
    return SerializeResponse(source=MarimoConvert.from_ir(ir).to_py())


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
) -> GetConfigurationResponse:
    """Get the current marimo configuration."""
    session = sessions.get(args.notebook_uri)
    if not session:
        logger.warning(f"No session found for {args.notebook_uri}")
        return GetConfigurationResponse(config=DEFAULT_CONFIG)

    return GetConfigurationResponse(config=session.get_config())


async def update_configuration(
    sessions: Sessions,
    args: NotebookCommand[UpdateConfigurationRequest],
) -> UpdateConfigurationResponse:
    """Update the marimo user configuration."""
    session = sessions.get(args.notebook_uri)
    if not session:
        logger.warning(f"No session found for {args.notebook_uri}")
        return UpdateConfigurationResponse(success=False, error="No session found")

    try:
        updated_config = session.save_config(
            cast("PartialMarimoConfig", args.inner.config),
        )

        return UpdateConfigurationResponse(success=True, config=updated_config)
    except Exception as e:
        logger.exception(f"Error updating configuration for {args.notebook_uri}")
        return UpdateConfigurationResponse(success=False, error=str(e))


async def set_display_theme(
    sessions: Sessions,
    args: SetDisplayThemeRequest,
) -> SetDisplayThemeResponse:
    """Set the display theme in all kernels without persisting to disk."""
    for session in sessions:
        config = session.get_config(hide_secrets=False)
        display = _get_display_config(config)
        updated = cast(
            "MarimoConfig", {**config, "display": {**display, "theme": args.theme}}
        )
        session.update_runtime_config(updated)
    return SetDisplayThemeResponse(success=True)


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


@dataclasses.dataclass(frozen=True)
class ApiContext:
    """Server-side dependencies a handler can reach for."""

    ls: LanguageServer
    sessions: Sessions


@dataclasses.dataclass(frozen=True)
class ApiMethod[Req, Res]:
    """One ``marimo.api`` method: the single source of truth for its wire contract.

    The server dispatches and validates wire values from this table. Genericity
    ties each entry's handler to its request/response annotations, so a
    mismatched handler fails type-checking at table construction.
    """

    name: str
    """Wire method name (kebab-case)."""

    request: TypeForm[Req]
    """msgspec annotation the incoming ``params`` must convert to."""

    response: TypeForm[Res] | None
    """msgspec annotation the handler's return value is validated against.

    ``None`` marks a fire-and-forget method whose response is always ``null``.
    """

    handler: Callable[[ApiContext, Req], typing.Awaitable[Res]]


API_METHODS: tuple[ApiMethod[typing.Any, typing.Any], ...] = (
    ApiMethod(
        "execute-cells",
        SessionCommand[ExecuteCellsRequest],
        None,
        lambda ctx, args: run(ctx.sessions, args),
    ),
    ApiMethod(
        "send-stdin",
        NotebookCommand[StdinRequest],
        None,
        lambda ctx, args: send_stdin(ctx.sessions, args),
    ),
    ApiMethod(
        "interrupt",
        NotebookCommand[InterruptRequest],
        None,
        lambda ctx, args: interrupt(ctx.sessions, args),
    ),
    ApiMethod(
        "delete-cell",
        NotebookCommand[DeleteCellRequest],
        None,
        lambda ctx, args: delete_cell(ctx.sessions, args),
    ),
    ApiMethod(
        "update-ui-element",
        NotebookCommand[UpdateUIElementRequest],
        None,
        lambda ctx, args: set_ui_element_value(ctx.sessions, args),
    ),
    ApiMethod(
        "set-model-value",
        NotebookCommand[ModelRequest],
        None,
        lambda ctx, args: set_model_value(ctx.sessions, args),
    ),
    ApiMethod(
        "invoke-function",
        NotebookCommand[InvokeFunctionCommand],
        None,
        lambda ctx, args: function_call_request(ctx.sessions, args),
    ),
    ApiMethod(
        "close-session",
        NotebookCommand[CloseSessionRequest],
        None,
        lambda ctx, args: close_session(ctx.sessions, args),
    ),
    ApiMethod(
        "serialize",
        SerializeRequest,
        SerializeResponse,
        lambda _ctx, args: serialize(args),
    ),
    # NOTE: the deserialize payload is marimo's `NotebookSerialization`, which
    # msgspec cannot introspect (it embeds `ast` nodes), so the response stays
    # opaque on the wire. The client parses it with its hand-written
    # `SerializedNotebook` schema (`extension/src/schemas/SerializedNotebook.ts`).
    ApiMethod(
        "deserialize",
        DeserializeRequest,
        dict[str, typing.Any],
        lambda _ctx, args: deserialize(args),
    ),
    ApiMethod(
        "get-package-list",
        PackageCommand[ListPackagesRequest],
        ListPackagesResponse,
        lambda _ctx, args: get_package_list(args),
    ),
    ApiMethod(
        "get-dependency-tree",
        PackageCommand[DependencyTreeRequest],
        DependencyTreeResponse,
        lambda _ctx, args: get_dependency_tree(args),
    ),
    ApiMethod(
        "get-configuration",
        NotebookCommand[GetConfigurationRequest],
        GetConfigurationResponse,
        lambda ctx, args: get_configuration(ctx.sessions, args),
    ),
    ApiMethod(
        "update-configuration",
        NotebookCommand[UpdateConfigurationRequest],
        UpdateConfigurationResponse,
        lambda ctx, args: update_configuration(ctx.sessions, args),
    ),
    ApiMethod(
        "set-display-theme",
        SetDisplayThemeRequest,
        SetDisplayThemeResponse,
        lambda ctx, args: set_display_theme(ctx.sessions, args),
    ),
    ApiMethod(
        "export-as-html",
        NotebookCommand[ExportAsHTMLRequest],
        str,
        lambda ctx, args: export_as_html(ctx.sessions, args),
    ),
    ApiMethod(
        "export-as-ipynb",
        NotebookCommand[ExportAsIpynbRequest],
        str,
        lambda ctx, args: export_as_ipynb(ctx.sessions, args),
    ),
    ApiMethod(
        "execute-scratchpad",
        SessionCommand[ExecuteScratchRequest],
        None,
        lambda ctx, args: execute_scratch(ctx.ls, ctx.sessions, args),
    ),
)

_API_BY_NAME = {method.name: method for method in API_METHODS}


async def handle_api_command(
    ls: LanguageServer, sessions: Sessions, method: str, params: dict
) -> object:
    """Unified API endpoint for all marimo internal methods.

    Converts ``params`` into the method's request type, runs the handler, and
    validates the result against the declared response annotation so the wire
    always matches the generated client schemas.
    """
    spec = _API_BY_NAME.get(method)
    if spec is None:
        logger.warning(f"Unknown API method: {method}")
        raise ValueError(method)

    request = msgspec.convert(params, type=spec.request)
    result = await spec.handler(ApiContext(ls=ls, sessions=sessions), request)

    if spec.response is None:
        return None

    payload = msgspec.to_builtins(result)
    validated = msgspec.convert(payload, type=spec.response)
    return msgspec.to_builtins(validated)
