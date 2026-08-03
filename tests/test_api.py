# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import MagicMock, patch

import msgspec
import pytest
from marimo._config.config import DEFAULT_CONFIG
from marimo._types.ids import RequestId

from marimo_lsp.api import (
    ApiBuilder,
    ApiContext,
    deserialize,
    get_configuration,
    list_sql_schemas,
    list_sql_tables,
    update_configuration,
)
from marimo_lsp.models import (
    DeserializeConvertible,
    DeserializeInvalidSyntax,
    DeserializeRequest,
    DeserializeSuccess,
    GetConfigurationRequest,
    ListSQLSchemasRequest,
    ListSQLTablesRequest,
    NotebookCommand,
    SetDisplayThemeRequest,
    UpdateConfigurationRequest,
)

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

NOTEBOOK_URI = "file:///notebook.py"


@pytest.mark.asyncio
async def test_deserialize_native_marimo_notebook() -> None:
    source = """\
import marimo

app = marimo.App()

if __name__ == "__main__":
    app.run()
"""

    result = await deserialize(_context(MagicMock()), DeserializeRequest(source=source))

    assert isinstance(result, DeserializeSuccess)


@pytest.mark.asyncio
async def test_deserialize_recovers_syntax_error_inside_cell() -> None:
    source = """\
import marimo

app = marimo.App()

@app.cell
def _():
    value = (
    return
"""

    result = await deserialize(_context(MagicMock()), DeserializeRequest(source=source))

    assert isinstance(result, DeserializeSuccess)
    assert [cell["code"] for cell in result.notebook.notebook["cells"]] == ["value = ("]


@pytest.mark.asyncio
async def test_deserialize_reports_unrecoverable_indentation_location() -> None:
    source = """\
import marimo
app = marimo.App()
@app.cell
def _():
    if True:
        x = 1
      y = 2
    return
"""
    result = await deserialize(
        _context(MagicMock()),
        DeserializeRequest(source=source),
    )

    assert isinstance(result, DeserializeInvalidSyntax)
    assert result.line == 7
    assert result.column is not None


@pytest.mark.asyncio
async def test_deserialize_classifies_plain_python() -> None:
    result = await deserialize(
        _context(MagicMock()), DeserializeRequest(source="print('hello')\n")
    )

    assert isinstance(result, DeserializeConvertible)


@pytest.mark.asyncio
async def test_deserialize_classifies_jupytext_percent_as_convertible() -> None:
    result = await deserialize(
        _context(MagicMock()),
        DeserializeRequest(source="# %%\nprint('hello')\n"),
    )

    assert isinstance(result, DeserializeConvertible)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source",
    [
        "print(\n",
        "def f(:\n",
        "import marimo\napp = marimo.App(\n",
    ],
)
async def test_deserialize_reports_syntax_errors_in_non_marimo_python(
    source: str,
) -> None:
    result = await deserialize(_context(MagicMock()), DeserializeRequest(source=source))

    assert isinstance(result, DeserializeInvalidSyntax)
    assert result.line is not None


@pytest.mark.asyncio
async def test_percent_marker_inside_string_is_just_convertible_python() -> None:
    result = await deserialize(
        _context(MagicMock()), DeserializeRequest(source='x = "# %%"\n')
    )

    assert isinstance(result, DeserializeConvertible)


@pytest.mark.asyncio
async def test_deserialize_propagates_unexpected_converter_error() -> None:
    with (
        patch(
            "marimo_lsp.api.MarimoConvert.from_py",
            side_effect=RuntimeError("converter broke"),
        ),
        pytest.raises(RuntimeError, match="converter broke"),
    ):
        await deserialize(
            _context(MagicMock()), DeserializeRequest(source="print('hello')")
        )


def _context(sessions: MagicMock) -> ApiContext:
    return ApiContext(ls=MagicMock(), sessions=sessions)


def test_api_builder_infers_contract_from_handler() -> None:
    builder = ApiBuilder()

    @builder("example")
    async def handler(
        _ctx: ApiContext,
        request: UpdateConfigurationRequest,
    ) -> str:
        return str(request.config)

    (method,) = builder.build()

    assert method.name == "example"
    assert method.request is UpdateConfigurationRequest
    assert method.response is str
    assert method.handler is handler


def test_api_builder_rejects_duplicate_methods() -> None:
    builder = ApiBuilder()

    @builder("duplicate")
    async def first(_ctx: ApiContext, _request: UpdateConfigurationRequest) -> None:
        pass

    @builder("duplicate")
    async def second(_ctx: ApiContext, _request: UpdateConfigurationRequest) -> None:
        pass

    with pytest.raises(ValueError, match="duplicate API method"):
        builder.build()


@pytest.mark.asyncio
async def test_update_configuration_returns_saved_config() -> None:
    session = MagicMock()
    session.save_config.return_value = DEFAULT_CONFIG
    sessions = MagicMock()
    sessions.get.return_value = session

    result = await update_configuration(
        _context(sessions),
        NotebookCommand(
            notebook_uri="file:///notebook.py",
            inner=UpdateConfigurationRequest(config={}),
        ),
    )

    assert result == DEFAULT_CONFIG


@pytest.mark.asyncio
async def test_update_configuration_returns_effective_config_without_session() -> None:
    sessions = MagicMock()
    sessions.get.return_value = None
    manager = MagicMock()
    manager.save_config.return_value = MagicMock(name="saved_user_config")
    manager.get_config.return_value = DEFAULT_CONFIG
    partial_config: dict[str, object] = {"runtime": {"on_cell_change": "lazy"}}

    with patch(
        "marimo_lsp.api.get_default_config_manager", return_value=manager
    ) as get_manager:
        result = await update_configuration(
            _context(sessions),
            NotebookCommand(
                notebook_uri="file:///notebook.py",
                inner=UpdateConfigurationRequest(config=partial_config),
            ),
        )

    get_manager.assert_called_once_with(current_path="/notebook.py")
    manager.save_config.assert_called_once_with(partial_config)
    manager.get_config.assert_called_once_with()
    assert result == DEFAULT_CONFIG


@pytest.mark.asyncio
async def test_get_configuration_loads_without_session() -> None:
    sessions = MagicMock()
    sessions.get.return_value = None
    manager = MagicMock()
    manager.get_config.return_value = DEFAULT_CONFIG

    with patch(
        "marimo_lsp.api.get_default_config_manager", return_value=manager
    ) as get_manager:
        result = await get_configuration(
            _context(sessions),
            NotebookCommand(
                notebook_uri="file:///notebook.py",
                inner=GetConfigurationRequest(),
            ),
        )

    get_manager.assert_called_once_with(current_path="/notebook.py")
    manager.get_config.assert_called_once_with()
    assert result.config == DEFAULT_CONFIG


@pytest.mark.asyncio
async def test_update_configuration_propagates_save_errors() -> None:
    session = MagicMock()
    session.save_config.side_effect = OSError("config is read-only")
    sessions = MagicMock()
    sessions.get.return_value = session

    with pytest.raises(OSError, match="config is read-only"):
        await update_configuration(
            _context(sessions),
            NotebookCommand(
                notebook_uri="file:///notebook.py",
                inner=UpdateConfigurationRequest(config={}),
            ),
        )


def test_display_theme_rejects_unresolved_theme() -> None:
    with pytest.raises(msgspec.ValidationError):
        msgspec.convert({"theme": "system"}, type=SetDisplayThemeRequest)


@pytest.mark.asyncio
async def test_list_sql_schemas_is_forwarded_to_the_kernel() -> None:
    request = ListSQLSchemasRequest(
        request_id=RequestId("schemas"),
        engine="warehouse",
        database="analytics",
        schema_path=["catalog"],
    )
    session = MagicMock()
    sessions = MagicMock()
    sessions.get.return_value = session

    await list_sql_schemas(
        _context(sessions),
        NotebookCommand(
            notebook_uri="file:///notebook.py",
            inner=request,
        ),
    )

    session.put_control_request.assert_called_once_with(
        request.as_command(), from_consumer_id=None
    )


@pytest.mark.asyncio
async def test_list_sql_tables_is_forwarded_to_the_kernel() -> None:
    request = ListSQLTablesRequest(
        request_id=RequestId("tables"),
        engine="warehouse",
        database="analytics",
        schema="events",
        schema_path=["catalog", "events"],
    )
    session = MagicMock()
    sessions = MagicMock()
    sessions.get.return_value = session

    await list_sql_tables(
        _context(sessions),
        NotebookCommand(
            notebook_uri="file:///notebook.py",
            inner=request,
        ),
    )

    session.put_control_request.assert_called_once_with(
        request.as_command(), from_consumer_id=None
    )


@pytest.mark.parametrize(
    ("handler", "sql_request"),
    [
        (
            list_sql_schemas,
            ListSQLSchemasRequest(
                request_id=RequestId("schemas"),
                engine="warehouse",
                database="analytics",
            ),
        ),
        (
            list_sql_tables,
            ListSQLTablesRequest(
                request_id=RequestId("tables"),
                engine="warehouse",
                database="analytics",
                schema="events",
            ),
        ),
    ],
)
@pytest.mark.asyncio
async def test_list_sql_metadata_rejects_a_missing_session(
    handler: Callable[..., Awaitable[None]],
    sql_request: ListSQLSchemasRequest | ListSQLTablesRequest,
) -> None:
    sessions = MagicMock()
    sessions.get.return_value = None

    with pytest.raises(ValueError, match=f"No session found for {NOTEBOOK_URI}"):
        await handler(
            _context(sessions),
            NotebookCommand(notebook_uri=NOTEBOOK_URI, inner=sql_request),
        )
