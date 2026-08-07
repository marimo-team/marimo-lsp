# Copyright 2026 Marimo. All rights reserved.

"""Handlers for marimo.api commands."""

from __future__ import annotations

import ast
import dataclasses
import inspect
import json
import keyword
import typing
from typing import TYPE_CHECKING, cast

import msgspec
from marimo._ast.app_config import _AppConfig
from marimo._ast.compiler import module_compile
from marimo._ast.parse import MarimoFileError
from marimo._config.config import MarimoConfig  # noqa: TC002 - API introspection
from marimo._config.manager import get_default_config_manager
from marimo._convert.converters import MarimoConvert
from marimo._export.exporter import Exporter, export_markdown
from marimo._export.requests import (
    HTMLExportRequest,
    IPYNBExportRequest,
    MarkdownExportRequest,
)
from marimo._export.serialization import serialize_notebook_snapshot
from marimo._runtime.commands import (
    ExecuteScratchpadCommand,
    InvokeFunctionCommand,
)
from marimo._runtime.packages.package_manager import PackageDescription
from marimo._runtime.packages.package_managers import create_package_manager
from marimo._schemas.export import ExportAsHTMLRequest, to_html_export_options
from marimo._schemas.export_options import IPYNBExportOptions, MarkdownExportOptions
from marimo._schemas.serialization import (
    AppInstantiation,
    Header,
)
from marimo._session.requests import InstantiateNotebookRequest
from marimo._session.state.serialize import serialize_session_view
from pygls.uris import to_fs_path
from typing_extensions import TypeForm

from marimo_lsp.app_file_manager import find_notebook_document, snapshot_for_scratchpad
from marimo_lsp.loggers import get_logger
from marimo_lsp.models import (
    CloseSessionRequest,
    DeleteCellRequest,
    DependencyTreeRequest,
    DependencyTreeResponse,
    DeserializeConvertible,
    DeserializeInvalidSyntax,
    DeserializeRequest,
    DeserializeResult,
    DeserializeSuccess,
    ExecuteCellsRequest,
    ExecuteScratchRequest,
    ExportAsIpynbRequest,
    ExportAsMarkdownRequest,
    GetConfigurationRequest,
    GetConfigurationResponse,
    InterruptRequest,
    ListPackagesRequest,
    ListPackagesResponse,
    ListSessionsRequest,
    ListSessionsResponse,
    ListSQLSchemasRequest,
    ListSQLTablesRequest,
    ModelRequest,
    MoveSessionRequest,
    NotebookCommand,
    NotebookDocument,
    PackageCommand,
    RestartSessionRequest,
    ScriptSource,
    SerializeResponse,
    SessionCommand,
    SetDisplayThemeRequest,
    SetDisplayThemeResponse,
    ShutdownAllSessionsRequest,
    StdinRequest,
    UpdateConfigurationRequest,
    UpdateUIElementRequest,
    VenvSource,
)
from marimo_lsp.package_manager import LspPackageManager

if TYPE_CHECKING:
    from marimo._config.config import (
        DisplayConfig,
        PartialMarimoConfig,
        SharingConfig,
    )
    from pygls.lsp.server import LanguageServer

    from marimo_lsp.sessions import Sessions


_APP_CONFIG_FIELD_NAMES = frozenset(
    field.name for field in dataclasses.fields(_AppConfig)
)


__all__ = ["API_METHODS", "ApiBuilder", "ApiMethod", "handle_api_command"]

logger = get_logger()
_API_HANDLER_PARAMETER_COUNT = 2


def _as_partial_marimo_config(config: dict[str, object]) -> PartialMarimoConfig:
    """Adapt a deep configuration patch to marimo's shallow partial type.

    Python cannot derive a recursive partial ``TypedDict`` from
    ``MarimoConfig``. Marimo accepts deep patches at runtime, even though its
    ``PartialMarimoConfig`` annotation only describes a shallow partial.
    Keep that typing assertion isolated at this API boundary.
    """
    return cast("PartialMarimoConfig", config)


@dataclasses.dataclass(frozen=True)
class ApiContext:
    """Server-side dependencies available to API handlers."""

    ls: LanguageServer
    sessions: Sessions


type ApiHandler[Req, Res] = typing.Callable[
    [ApiContext, Req],
    typing.Awaitable[Res],
]


@dataclasses.dataclass(frozen=True)
class ApiMethod[Req, Res]:
    """One ``marimo.api`` method consumed by dispatch and schema generation."""

    name: str
    request: TypeForm[Req]
    response: TypeForm[Res]
    handler: ApiHandler[Req, Res]


class ApiBuilder:
    """Build a method table from typed async handler declarations."""

    def __init__(self) -> None:
        self._methods: list[ApiMethod[typing.Any, typing.Any]] = []
        self._built = False

    def __call__[Req, Res](
        self,
        name: str,
    ) -> typing.Callable[[ApiHandler[Req, Res]], ApiHandler[Req, Res]]:
        """Register an async handler under its wire method name."""

        def register(handler: ApiHandler[Req, Res]) -> ApiHandler[Req, Res]:
            if self._built:
                msg = "cannot register API methods after build()"
                raise RuntimeError(msg)
            if not inspect.iscoroutinefunction(handler):
                msg = f"API handler {name!r} must be async"
                raise TypeError(msg)

            parameters = list(inspect.signature(handler).parameters.values())
            positional = {
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            }
            if len(parameters) != _API_HANDLER_PARAMETER_COUNT or any(
                parameter.kind not in positional for parameter in parameters
            ):
                msg = f"API handler {name!r} must accept (ApiContext, request)"
                raise TypeError(msg)

            hints = typing.get_type_hints(handler)
            context_parameter, request_parameter = parameters
            if hints.get(context_parameter.name) is not ApiContext:
                msg = f"API handler {name!r} first parameter must be ApiContext"
                raise TypeError(msg)
            if request_parameter.name not in hints:
                msg = f"API handler {name!r} request parameter must be annotated"
                raise TypeError(msg)
            if "return" not in hints:
                msg = f"API handler {name!r} return type must be annotated"
                raise TypeError(msg)

            request = cast("TypeForm[Req]", hints[request_parameter.name])
            response_hint = hints["return"]
            response = cast(
                "TypeForm[Res]",
                type(None) if response_hint is None else response_hint,
            )
            self._methods.append(ApiMethod(name, request, response, handler))
            return handler

        return register

    def build(self) -> tuple[ApiMethod[typing.Any, typing.Any], ...]:
        """Validate and return the immutable method table."""
        if self._built:
            msg = "API method table has already been built"
            raise RuntimeError(msg)

        names: set[str] = set()
        for method in self._methods:
            if method.name in names:
                msg = f"duplicate API method: {method.name!r}"
                raise ValueError(msg)
            names.add(method.name)

        self._built = True
        return tuple(self._methods)


marimo_api = ApiBuilder()


class SessionNotFoundError(ValueError):
    """Raised when an API command requires a live notebook session."""

    def __init__(self, notebook_uri: str) -> None:
        super().__init__(f"No session found for {notebook_uri}")


def _get_display_config(config: MarimoConfig) -> DisplayConfig:
    """Extract the display config from a MarimoConfig.

    Workaround for ty not resolving the 'display' key on MarimoConfig.
    """
    return cast("DisplayConfig", config.get("display", {}))


@marimo_api("execute-cells")
async def run(
    ctx: ApiContext,
    args: SessionCommand[ExecuteCellsRequest],
) -> None:
    logger.info(f"run for {args.notebook_uri}")
    session = await ctx.sessions.start(
        args.notebook_uri, args.executable, args.working_directory
    )
    session.mark_running()

    session.instantiate(
        InstantiateNotebookRequest(auto_run=False, object_ids=[], values=[]),
        http_request=None,
    )
    session.put_control_request(args.inner.as_command(), from_consumer_id=None)
    logger.info(f"Execution request sent for {args.notebook_uri}")


@marimo_api("update-ui-element")
async def set_ui_element_value(
    ctx: ApiContext,
    args: NotebookCommand[UpdateUIElementRequest],
) -> None:
    logger.info(f"set_ui_element_value for {args.notebook_uri}")
    session = ctx.sessions.get(args.notebook_uri)
    assert session, f"No session in workspace for {args.notebook_uri}"
    session.put_control_request(args.inner.as_command(), from_consumer_id=None)


@marimo_api("set-model-value")
async def set_model_value(
    ctx: ApiContext,
    args: NotebookCommand[ModelRequest],
) -> None:
    logger.info(f"set_model_value for {args.notebook_uri}")
    session = ctx.sessions.get(args.notebook_uri)
    assert session, f"No session in workspace for {args.notebook_uri}"
    session.put_control_request(args.inner.as_command(), from_consumer_id=None)


@marimo_api("invoke-function")
async def function_call_request(
    ctx: ApiContext,
    args: NotebookCommand[InvokeFunctionCommand],
) -> None:
    logger.info(f"function_call_request for {args.notebook_uri}")
    session = ctx.sessions.get(args.notebook_uri)
    assert session, f"No session in workspace for {args.notebook_uri}"
    session.put_control_request(args.inner, from_consumer_id=None)


@marimo_api("interrupt")
async def interrupt(
    ctx: ApiContext,
    args: NotebookCommand[InterruptRequest],
) -> None:
    logger.info(f"interrupt for {args.notebook_uri}")
    session = ctx.sessions.get(args.notebook_uri)
    if session:
        session.try_interrupt()
        logger.info(f"Interrupt request sent for {args.notebook_uri}")
    else:
        logger.warning(f"No session found for {args.notebook_uri}")


@marimo_api("delete-cell")
async def delete_cell(
    ctx: ApiContext,
    args: NotebookCommand[DeleteCellRequest],
) -> None:
    logger.info(f"delete_cell for {args.notebook_uri}")
    session = ctx.sessions.get(args.notebook_uri)
    if session:
        session.put_control_request(args.inner.as_command(), from_consumer_id=None)
        logger.info(f"Delete cell request sent for {args.notebook_uri}")
    else:
        logger.warning(f"No session found for {args.notebook_uri}")


@marimo_api("list-sql-schemas")
async def list_sql_schemas(
    ctx: ApiContext,
    args: NotebookCommand[ListSQLSchemasRequest],
) -> None:
    """Request the immediate child schemas at a database path."""
    session = ctx.sessions.get(args.notebook_uri)
    if session is None:
        raise SessionNotFoundError(args.notebook_uri)
    session.put_control_request(args.inner.as_command(), from_consumer_id=None)


@marimo_api("list-sql-tables")
async def list_sql_tables(
    ctx: ApiContext,
    args: NotebookCommand[ListSQLTablesRequest],
) -> None:
    """Request the tables belonging to a schema path."""
    session = ctx.sessions.get(args.notebook_uri)
    if session is None:
        raise SessionNotFoundError(args.notebook_uri)
    session.put_control_request(args.inner.as_command(), from_consumer_id=None)


@marimo_api("send-stdin")
async def send_stdin(
    ctx: ApiContext,
    args: NotebookCommand[StdinRequest],
) -> None:
    logger.info(f"send_stdin for {args.notebook_uri}")
    session = ctx.sessions.get(args.notebook_uri)
    if session:
        session.put_input(args.inner.text)
    else:
        logger.warning(f"No session found for {args.notebook_uri}")


@marimo_api("close-session")
async def close_session(
    ctx: ApiContext,
    args: NotebookCommand[CloseSessionRequest],
) -> None:
    logger.info(f"close_session for {args.notebook_uri}")
    ctx.sessions.close(args.notebook_uri)


@marimo_api("restart-session")
async def restart_session(
    ctx: ApiContext,
    args: NotebookCommand[RestartSessionRequest],
) -> None:
    logger.info(f"restart_session for {args.notebook_uri}")
    restarted = await ctx.sessions.restart(
        args.notebook_uri,
        executable=args.inner.executable,
        working_directory=args.inner.working_directory,
        create_if_missing=args.inner.create_if_missing,
    )
    if restarted is None:
        raise SessionNotFoundError(args.notebook_uri)


@marimo_api("move-session")
async def move_session(
    ctx: ApiContext,
    args: NotebookCommand[MoveSessionRequest],
) -> None:
    logger.info(
        f"move_session from {args.notebook_uri} to {args.inner.new_notebook_uri}"
    )
    ctx.sessions.move(args.notebook_uri, args.inner.new_notebook_uri)


@marimo_api("list-sessions")
async def list_sessions(
    ctx: ApiContext,
    _args: ListSessionsRequest,
) -> ListSessionsResponse:
    return ListSessionsResponse(sessions=ctx.sessions.describe())


@marimo_api("shutdown-all-sessions")
async def shutdown_all_sessions(
    ctx: ApiContext,
    _args: ShutdownAllSessionsRequest,
) -> None:
    """Close every live kernel session with one collection mutation."""
    ctx.sessions.close_all()


@marimo_api("execute-scratchpad")
async def execute_scratch(
    ctx: ApiContext,
    args: SessionCommand[ExecuteScratchRequest],
) -> None:
    """Execute code in the scratchpad (isolated from dependency graph).

    Populates the document + output snapshot on the command so that
    ``marimo._code_mode.get_context()`` can bind inside the kernel. Cells come
    from the LSP notebook document (id-aligned with VS Code);
    outputs come from the session view.

    Creates the session on demand when none exists, like :func:`run`.
    """
    logger.info(f"execute_scratch for {args.notebook_uri}")
    try:
        notebook = find_notebook_document(ctx.ls.workspace, args.notebook_uri)
    except KeyError:
        logger.warning(
            f"No notebook document found for {args.notebook_uri}; "
            "skipping scratchpad execution"
        )
        return

    session = await ctx.sessions.start(
        args.notebook_uri, args.executable, args.working_directory
    )
    session.mark_running()

    session.instantiate(
        InstantiateNotebookRequest(auto_run=False, object_ids=[], values=[]),
        http_request=None,
    )

    notebook_cells, cell_outputs = snapshot_for_scratchpad(
        workspace=ctx.ls.workspace,
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


@marimo_api("get-package-list")
async def get_package_list(
    _ctx: ApiContext,
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


@marimo_api("get-dependency-tree")
async def get_dependency_tree(
    _ctx: ApiContext,
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


@marimo_api("serialize")
async def serialize(_ctx: ApiContext, args: NotebookDocument) -> SerializeResponse:
    ir = MarimoConvert.from_notebook_v1(args.notebook).to_ir()
    known_options = {
        name: value
        for name, value in args.app_config.items()
        if name in _APP_CONFIG_FIELD_NAMES
    }
    ir = dataclasses.replace(
        ir,
        app=AppInstantiation(options=known_options),
        header=Header(value=args.header) if args.header is not None else None,
    )
    source = MarimoConvert.from_ir(ir).to_py()
    return SerializeResponse(
        source=_restore_unknown_app_options(source, args.app_config)
    )


def _restore_unknown_app_options(source: str, options: dict[str, object]) -> str:
    """Restore opaque options dropped by marimo's current code generator.

    Marimo parses unknown literal kwargs, but ``generate_filecontents_from_ir``
    projects them through its installed ``_AppConfig`` and loses them. Replace
    only the generated ``marimo.App(...)`` expression so future options survive
    a save without reformatting the rest of the notebook.
    """
    known_options = _APP_CONFIG_FIELD_NAMES
    unknown_options = [
        (name, value) for name, value in options.items() if name not in known_options
    ]
    if not unknown_options:
        return source

    rendered_options: list[str] = []
    for name, value in unknown_options:
        if not name.isidentifier() or keyword.iskeyword(name):
            msg = f"App config key cannot be represented as a keyword: {name!r}"
            raise ValueError(msg)
        rendered = repr(value)
        try:
            ast.literal_eval(rendered)
        except (ValueError, SyntaxError) as error:
            msg = f"App config value is not a Python literal: {name!r}={rendered}"
            raise ValueError(msg) from error
        rendered_options.append(f"{name}={rendered}")

    tree = ast.parse(source)
    call = next(
        (
            node.value
            for node in tree.body
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id == "app"
                for target in node.targets
            )
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Attribute)
            and isinstance(node.value.func.value, ast.Name)
            and node.value.func.value.id == "marimo"
            and node.value.func.attr == "App"
        ),
        None,
    )
    if call is None or call.end_lineno is None or call.end_col_offset is None:
        msg = "Generated notebook did not contain marimo.App(...)"
        raise ValueError(msg)

    lines = source.splitlines(keepends=True)

    def offset(line_number: int, byte_column: int) -> int:
        line = lines[line_number - 1]
        char_column = len(line.encode()[:byte_column].decode())
        return sum(map(len, lines[: line_number - 1])) + char_column

    end = offset(call.end_lineno, call.end_col_offset)
    separator = ", " if call.args or call.keywords else ""
    insertion = f"{separator}{', '.join(rendered_options)}"
    return f"{source[: end - 1]}{insertion}{source[end - 1 :]}"


@marimo_api("deserialize")
async def deserialize(
    _ctx: ApiContext,
    args: DeserializeRequest,
) -> DeserializeResult:
    try:
        converter = MarimoConvert.from_py(args.source)
        ir = converter.to_ir()
    except SyntaxError as error:
        return _classify_convertible(args.source, syntax_error=error)
    except MarimoFileError as error:
        if str(error) != "`marimo.App` definition expected.":
            raise
        return _classify_convertible(args.source)

    if not ir.valid:
        return _classify_convertible(args.source)

    return DeserializeSuccess(
        notebook=NotebookDocument(
            notebook=converter.to_notebook_v1(),
            app_config={**_AppConfig().asdict(), **ir.app.options},
            header=ir.header.value if ir.header is not None else None,
        )
    )


def _syntax_error_position(
    source: str, error: SyntaxError
) -> tuple[int | None, int | None]:
    if error.filename == "notebook.py":
        return error.lineno, error.offset

    # Some failures in marimo's cell fallback are relative to the extracted
    # cell body. Only translate them when the offending line is unambiguous.
    if error.text is None:
        return None, None
    error_line = error.text.rstrip("\r\n")
    matches = [
        line_number
        for line_number, source_line in enumerate(source.splitlines(), start=1)
        if source_line == error_line
    ]
    if len(matches) != 1:
        return None, None
    return matches[0], error.offset


def _classify_convertible(
    source: str,
    syntax_error: SyntaxError | None = None,
) -> DeserializeConvertible | DeserializeInvalidSyntax:
    try:
        # Use the same compiler as marimo cells so valid notebook constructs,
        # notably top-level await, are not rejected as ordinary scripts.
        module_compile(source)
    except SyntaxError as error:
        if "# %%" in source:
            try:
                # Jupytext magics are not Python syntax until the percent
                # converter rewrites them. Validate the conversion we actually
                # offer instead of guessing from the original source.
                converted = MarimoConvert.from_non_marimo_python_script(source).to_ir()
                for cell in converted.cells:
                    module_compile(cell.code)
            except SyntaxError:
                pass
            else:
                return DeserializeConvertible()

        failure = syntax_error or error
        line, column = _syntax_error_position(source, failure)
        return DeserializeInvalidSyntax(line=line, column=column)
    return DeserializeConvertible()


@marimo_api("get-configuration")
async def get_configuration(
    ctx: ApiContext,
    args: NotebookCommand[GetConfigurationRequest],
) -> GetConfigurationResponse:
    """Get the current marimo configuration."""
    session = ctx.sessions.get(args.notebook_uri)
    if not session:
        manager = get_default_config_manager(current_path=to_fs_path(args.notebook_uri))
        return GetConfigurationResponse(config=manager.get_config())

    return GetConfigurationResponse(config=session.get_config())


@marimo_api("update-configuration")
async def update_configuration(
    ctx: ApiContext,
    args: NotebookCommand[UpdateConfigurationRequest],
) -> MarimoConfig:
    """Update the marimo user configuration."""
    config = _as_partial_marimo_config(args.inner.config)
    session = ctx.sessions.get(args.notebook_uri)
    if not session:
        manager = get_default_config_manager(current_path=to_fs_path(args.notebook_uri))
        manager.save_config(config)
        return manager.get_config()

    return session.save_config(config)


@marimo_api("set-display-theme")
async def set_display_theme(
    ctx: ApiContext,
    args: SetDisplayThemeRequest,
) -> SetDisplayThemeResponse:
    """Set the display theme in all kernels without persisting to disk."""
    for session in ctx.sessions:
        config = session.get_config(hide_secrets=False)
        display = _get_display_config(config)
        updated = cast(
            "MarimoConfig", {**config, "display": {**display, "theme": args.theme}}
        )
        session.update_runtime_config(updated)
    return SetDisplayThemeResponse(success=True)


@marimo_api("export-as-html")
async def export_as_html(
    ctx: ApiContext,
    args: NotebookCommand[ExportAsHTMLRequest],
) -> str:
    """Export the notebook as HTML with current outputs."""
    logger.info(f"export_as_html for {args.notebook_uri}")
    session = ctx.sessions.get(args.notebook_uri)
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


@marimo_api("export-as-ipynb")
async def export_as_ipynb(
    ctx: ApiContext,
    args: NotebookCommand[ExportAsIpynbRequest],
) -> str:
    """Export the notebook as ipynb with current outputs."""
    logger.info(f"export_as_ipynb for {args.notebook_uri}")
    session = ctx.sessions.get(args.notebook_uri)
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


@marimo_api("export-as-markdown")
async def export_as_markdown(
    ctx: ApiContext,
    args: NotebookCommand[ExportAsMarkdownRequest],
) -> str:
    """Export the notebook as Markdown."""
    logger.info(f"export_as_markdown for {args.notebook_uri}")
    session = ctx.sessions.get(args.notebook_uri)
    assert session, f"No session in workspace for {args.notebook_uri}"

    result = export_markdown(
        MarkdownExportRequest(
            notebook=session.app.to_ir(),
            options=MarkdownExportOptions(
                filename=session.filename,
                source_filename=session.filename,
            ),
        )
    )
    return result.text


API_METHODS = marimo_api.build()

_API_BY_NAME = {method.name: method for method in API_METHODS}


async def handle_api_command(
    ls: LanguageServer,
    sessions: Sessions,
    method: str,
    params: dict[str, object],
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

    validated = msgspec.convert(result, type=spec.response)
    return msgspec.to_builtins(validated)
