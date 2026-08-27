# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, cast
from unittest.mock import AsyncMock, MagicMock, patch

import msgspec
import pytest
from marimo._config.config import DEFAULT_CONFIG
from marimo._convert.converters import MarimoConvert
from marimo._types.ids import RequestId, SessionId

from marimo_lsp import protocol
from marimo_lsp.api import (
    ApiContext,
    CommandBuilder,
    KernelSessionMismatchError,
    KernelSessionRequiredError,
    _restore_unknown_app_options,
    delete_cell,
    deserialize,
    execute_scratch,
    export_as_markdown,
    function_call_request,
    get_configuration,
    handle_command,
    interrupt,
    list_sql_schemas,
    list_sql_tables,
    send_stdin,
    set_model_value,
    set_ui_element_value,
    update_configuration,
)
from marimo_lsp.models import (
    DeserializeConvertible,
    DeserializeInvalidSyntax,
    DeserializeSuccess,
    ListSQLSchemasRequest,
    ListSQLTablesRequest,
)

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

NOTEBOOK_URI = "file:///notebook.py"


@pytest.mark.asyncio
async def test_execute_scratch_skips_a_run_cancelled_before_startup() -> None:
    sessions = MagicMock()
    sessions.take_scratchpad_cancellation.return_value = True
    sessions.start = AsyncMock()

    await execute_scratch(
        _context(sessions),
        protocol.ExecuteScratchpad(
            notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
            executable="/usr/bin/python",
            working_directory="/workspace",
            code="print('late')",
            run_id="run-1",
        ),
    )

    sessions.start.assert_not_awaited()


@pytest.mark.asyncio
async def test_execute_scratch_skips_a_run_cancelled_during_startup() -> None:
    sessions = MagicMock()
    sessions.take_scratchpad_cancellation.side_effect = [False, True]
    session = MagicMock()
    session.wait_until_idle = AsyncMock(return_value=True)
    sessions.start = AsyncMock(return_value=session)

    with patch("marimo_lsp.api.find_notebook_document", return_value=MagicMock()):
        await execute_scratch(
            _context(sessions),
            protocol.ExecuteScratchpad(
                notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
                executable="/usr/bin/python",
                working_directory="/workspace",
                code="print('late')",
                run_id="run-1",
            ),
        )

    sessions.start.assert_awaited_once()
    session.mark_running.assert_not_called()
    session.put_control_request.assert_not_called()


@pytest.mark.asyncio
async def test_execute_scratch_claims_idle_session_before_dispatch() -> None:
    sessions = MagicMock()
    sessions.take_scratchpad_cancellation.return_value = False
    session = MagicMock()
    session.wait_until_idle = AsyncMock(return_value=True)
    session.try_start_scratchpad.side_effect = [False, True]
    sessions.start = AsyncMock(return_value=session)

    with (
        patch("marimo_lsp.api.find_notebook_document", return_value=MagicMock()),
        patch("marimo_lsp.api.snapshot_for_scratchpad", return_value=((), {})),
    ):
        await execute_scratch(
            _context(sessions),
            protocol.ExecuteScratchpad(
                notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
                executable="/usr/bin/python",
                working_directory="/workspace",
                code="print('later')",
                run_id="run-1",
            ),
        )

    assert session.wait_until_idle.await_count == 2
    assert session.try_start_scratchpad.call_count == 2
    session.put_control_request.assert_called_once()


@pytest.mark.asyncio
async def test_run_correlated_interrupt_records_scratchpad_cancellation() -> None:
    sessions = MagicMock()

    await interrupt(
        _context(sessions),
        protocol.Interrupt(
            notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
            run_id="run-1",
        ),
    )

    sessions.cancel_scratchpad.assert_called_once_with(NOTEBOOK_URI, "run-1")
    sessions.get.assert_not_called()


@pytest.mark.asyncio
async def test_send_stdin_targets_one_exact_kernel_session() -> None:
    session_id = SessionId("00000000-0000-4000-8000-000000000001")
    session = MagicMock(session_id=session_id)
    sessions = MagicMock()
    sessions.get.return_value = session

    await send_stdin(
        _context(sessions),
        protocol.SendStdin(
            notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
            kernel_session_id=protocol.KernelSessionId(str(session_id)),
            text="answer",
        ),
    )

    session.put_input.assert_called_once_with("answer")


@pytest.mark.asyncio
async def test_send_stdin_rejects_a_replaced_kernel_session() -> None:
    session = MagicMock(session_id=SessionId("00000000-0000-4000-8000-000000000002"))
    sessions = MagicMock()
    sessions.get.return_value = session

    with pytest.raises(KernelSessionMismatchError):
        await send_stdin(
            _context(sessions),
            protocol.SendStdin(
                notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
                kernel_session_id=protocol.KernelSessionId(
                    "00000000-0000-4000-8000-000000000001"
                ),
                text="stale",
            ),
        )

    session.put_input.assert_not_called()


STALE_SESSION_ID = SessionId("00000000-0000-4000-8000-000000000001")
LIVE_SESSION_ID = SessionId("00000000-0000-4000-8000-000000000002")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("handler", "command"),
    [
        (
            set_ui_element_value,
            protocol.UpdateUiElement(
                notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
                kernel_session_id=protocol.KernelSessionId(str(STALE_SESSION_ID)),
                object_ids=[],
                values=[],
            ),
        ),
        (
            set_model_value,
            protocol.SetModelValue(
                notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
                kernel_session_id=protocol.KernelSessionId(str(STALE_SESSION_ID)),
                model_id="model-1",
                message=protocol.ModelUpdateMessage(state={}, buffer_paths=[]),
                buffers=[],
            ),
        ),
        (
            function_call_request,
            protocol.InvokeFunction(
                notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
                kernel_session_id=protocol.KernelSessionId(str(STALE_SESSION_ID)),
                function_call_id="request-1",
                namespace="ns",
                function_name="fn",
                args={},
            ),
        ),
        (
            delete_cell,
            protocol.DeleteCell(
                notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
                kernel_session_id=protocol.KernelSessionId(str(STALE_SESSION_ID)),
                cell_id=protocol.CellId("cell-1"),
            ),
        ),
        (
            list_sql_schemas,
            protocol.ListSqlSchemas(
                notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
                kernel_session_id=protocol.KernelSessionId(str(STALE_SESSION_ID)),
                request_id="request-1",
                engine="duckdb",
                database="db",
            ),
        ),
        (
            list_sql_tables,
            protocol.ListSqlTables(
                notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
                kernel_session_id=protocol.KernelSessionId(str(STALE_SESSION_ID)),
                request_id="request-1",
                engine="duckdb",
                database="db",
                schema="main",
            ),
        ),
    ],
)
async def test_kernel_commands_reject_a_replaced_kernel_session(
    handler: Callable[..., Awaitable[None]],
    command: protocol.Command,
) -> None:
    session = MagicMock(session_id=LIVE_SESSION_ID)
    sessions = MagicMock()
    sessions.get.return_value = session

    with pytest.raises(KernelSessionMismatchError):
        await handler(
            _context(sessions),
            command,
        )

    session.put_control_request.assert_not_called()


@pytest.mark.asyncio
async def test_interrupt_rejects_a_replaced_kernel_session() -> None:
    session = MagicMock(session_id=LIVE_SESSION_ID)
    sessions = MagicMock()
    sessions.get.return_value = session

    with pytest.raises(KernelSessionMismatchError):
        await interrupt(
            _context(sessions),
            protocol.Interrupt(
                notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
                kernel_session_id=protocol.KernelSessionId(str(STALE_SESSION_ID)),
            ),
        )

    session.try_interrupt.assert_not_called()


@pytest.mark.asyncio
async def test_interrupt_requires_a_kernel_session_id() -> None:
    sessions = MagicMock()

    with pytest.raises(KernelSessionRequiredError):
        await interrupt(
            _context(sessions),
            protocol.Interrupt(notebook_uri=protocol.NotebookUri(NOTEBOOK_URI)),
        )

    sessions.get.assert_not_called()
    sessions.cancel_scratchpad.assert_not_called()


@pytest.mark.asyncio
async def test_deserialize_native_marimo_notebook() -> None:
    source = """\
import marimo

app = marimo.App()

if __name__ == "__main__":
    app.run()
"""

    result = await deserialize(
        _context(MagicMock()), protocol.Deserialize(source=source)
    )

    assert isinstance(result, DeserializeSuccess)


@pytest.mark.asyncio
async def test_legacy_and_unknown_app_config_round_trip_over_command_wire() -> None:
    source = """\
import marimo

app = marimo.App(
    width="wide",
    auto_download=["html"],
    future_setting="keep",
    asdict="method-name collision",
)

if __name__ == "__main__":
    app.run()
"""

    deserialized = cast(
        "dict[str, object]",
        await handle_command(
            MagicMock(),
            MagicMock(),
            protocol.Deserialize(source=source),
        ),
    )
    deserialized_notebook = cast("dict[str, object]", deserialized["notebook"])
    app_config = cast("dict[str, object]", deserialized_notebook["appConfig"])
    assert app_config["width"] == "wide"
    assert app_config["auto_download"] == ["html"]
    assert app_config["future_setting"] == "keep"
    assert app_config["asdict"] == "method-name collision"

    serialized = cast(
        "dict[str, object]",
        await handle_command(
            MagicMock(),
            MagicMock(),
            msgspec.convert(
                {"kind": "serialize", **deserialized_notebook},
                type=protocol.Command,
            ),
        ),
    )
    serialized_source = serialized["source"]
    assert isinstance(serialized_source, str)
    reparsed_options = MarimoConvert.from_py(serialized_source).to_ir().app.options
    assert reparsed_options["width"] == "wide"
    assert reparsed_options["auto_download"] == ["html"]
    assert reparsed_options["future_setting"] == "keep"
    assert reparsed_options["asdict"] == "method-name collision"


def test_restore_unknown_app_options_reports_non_literal_value() -> None:
    value = object()

    with pytest.raises(ValueError, match=r"future_setting.*object"):
        _restore_unknown_app_options(
            "import marimo\napp = marimo.App()\n",
            {"future_setting": value},
        )


@pytest.mark.asyncio
async def test_export_as_markdown() -> None:
    source = """\
import marimo

__generated_with = "0.23.16"
app = marimo.App()

@app.cell
def _():
    x = 1
    return (x,)

if __name__ == "__main__":
    app.run()
"""
    session = MagicMock()
    session.filename = "/workspace/report.py"
    session.app.to_ir.return_value = MarimoConvert.from_py(source).to_ir()
    sessions = MagicMock()
    sessions.get.return_value = session

    markdown = await export_as_markdown(
        _context(sessions),
        protocol.ExportMarkdown(notebook_uri=protocol.NotebookUri(NOTEBOOK_URI)),
    )

    assert "title: Report" in markdown
    assert "```python {.marimo}\nx = 1\n```" in markdown


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

    result = await deserialize(
        _context(MagicMock()), protocol.Deserialize(source=source)
    )

    assert isinstance(result, DeserializeSuccess)
    assert [cell["code"] for cell in result.notebook.notebook["cells"]] == ["value = ("]


@pytest.mark.asyncio
async def test_deserialize_recovers_indentation_error_inside_cell() -> None:
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
        protocol.Deserialize(source=source),
    )

    assert isinstance(result, DeserializeSuccess)
    assert [cell["code"] for cell in result.notebook.notebook["cells"]] == [
        "if True:\n    x = 1\n  y = 2"
    ]


@pytest.mark.asyncio
async def test_deserialize_classifies_plain_python() -> None:
    result = await deserialize(
        _context(MagicMock()), protocol.Deserialize(source="print('hello')\n")
    )

    assert isinstance(result, DeserializeConvertible)


@pytest.mark.asyncio
async def test_deserialize_classifies_jupytext_percent_as_convertible() -> None:
    result = await deserialize(
        _context(MagicMock()),
        protocol.Deserialize(source="# %%\nprint('hello')\n"),
    )

    assert isinstance(result, DeserializeConvertible)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source",
    [
        "await fetch_data()\n",
        "# %%\nawait fetch_data()\n",
        "# %%\n%matplotlib inline\n",
        "# %%\n%%bash\necho hello\n",
    ],
)
async def test_deserialize_accepts_convertible_notebook_syntax(source: str) -> None:
    result = await deserialize(
        _context(MagicMock()), protocol.Deserialize(source=source)
    )

    assert isinstance(result, DeserializeConvertible)


@pytest.mark.asyncio
async def test_deserialize_rejects_malformed_jupytext_cell() -> None:
    result = await deserialize(
        _context(MagicMock()), protocol.Deserialize(source="# %%\nprint(\n")
    )

    assert isinstance(result, DeserializeInvalidSyntax)
    assert result.line == 2


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
    result = await deserialize(
        _context(MagicMock()), protocol.Deserialize(source=source)
    )

    assert isinstance(result, DeserializeInvalidSyntax)
    assert result.line is not None


@pytest.mark.asyncio
async def test_percent_marker_inside_string_is_just_convertible_python() -> None:
    result = await deserialize(
        _context(MagicMock()), protocol.Deserialize(source='x = "# %%"\n')
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
            _context(MagicMock()), protocol.Deserialize(source="print('hello')")
        )


def _context(sessions: MagicMock) -> ApiContext:
    return ApiContext(ls=MagicMock(), sessions=sessions)


def test_command_builder_infers_contract_from_handler() -> None:
    builder = CommandBuilder()

    @builder(protocol.UpdateConfiguration)
    async def handler(
        _ctx: ApiContext,
        request: protocol.UpdateConfiguration,
    ) -> str:
        return str(request.config)

    (command,) = builder.build()

    assert command.request is protocol.UpdateConfiguration
    assert command.response is str
    assert command.handler is handler


def test_command_builder_rejects_duplicate_commands() -> None:
    builder = CommandBuilder()

    @builder(protocol.UpdateConfiguration)
    async def first(_ctx: ApiContext, _request: protocol.UpdateConfiguration) -> None:
        pass

    @builder(protocol.UpdateConfiguration)
    async def second(_ctx: ApiContext, _request: protocol.UpdateConfiguration) -> None:
        pass

    with pytest.raises(ValueError, match="duplicate command type"):
        builder.build()


@pytest.mark.asyncio
async def test_update_configuration_returns_saved_config() -> None:
    session = MagicMock()
    session.save_config.return_value = DEFAULT_CONFIG
    sessions = MagicMock()
    sessions.get.return_value = session

    result = await update_configuration(
        _context(sessions),
        protocol.UpdateConfiguration(
            notebook_uri=protocol.NotebookUri("file:///notebook.py"),
            config={},
        ),
    )

    assert result == DEFAULT_CONFIG


@pytest.mark.asyncio
async def test_update_configuration_returns_effective_config_without_session(
    tmp_path: Path,
) -> None:
    sessions = MagicMock()
    sessions.get.return_value = None
    manager = MagicMock()
    manager.save_config.return_value = MagicMock(name="saved_user_config")
    manager.get_config.return_value = DEFAULT_CONFIG
    partial_config: dict[str, object] = {"runtime": {"on_cell_change": "lazy"}}
    notebook_path = tmp_path / "notebook.py"

    with patch(
        "marimo_lsp.api.get_default_config_manager", return_value=manager
    ) as get_manager:
        result = await update_configuration(
            _context(sessions),
            protocol.UpdateConfiguration(
                notebook_uri=protocol.NotebookUri(notebook_path.as_uri()),
                config=partial_config,
            ),
        )

    get_manager.assert_called_once()
    assert Path(get_manager.call_args.kwargs["current_path"]) == notebook_path
    manager.save_config.assert_called_once_with(partial_config)
    manager.get_config.assert_called_once_with()
    assert result == DEFAULT_CONFIG


@pytest.mark.asyncio
async def test_get_configuration_loads_without_session(tmp_path: Path) -> None:
    sessions = MagicMock()
    sessions.get.return_value = None
    manager = MagicMock()
    manager.get_config.return_value = DEFAULT_CONFIG
    notebook_path = tmp_path / "notebook.py"

    with patch(
        "marimo_lsp.api.get_default_config_manager", return_value=manager
    ) as get_manager:
        result = await get_configuration(
            _context(sessions),
            protocol.GetConfiguration(
                notebook_uri=protocol.NotebookUri(notebook_path.as_uri()),
            ),
        )

    get_manager.assert_called_once()
    assert Path(get_manager.call_args.kwargs["current_path"]) == notebook_path
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
            protocol.UpdateConfiguration(
                notebook_uri=protocol.NotebookUri("file:///notebook.py"),
                config={},
            ),
        )


def test_display_theme_rejects_unresolved_theme() -> None:
    with pytest.raises(msgspec.ValidationError):
        msgspec.convert(
            {"kind": "set-display-theme", "theme": "system"},
            type=protocol.Command,
        )


@pytest.mark.asyncio
async def test_list_sql_schemas_is_forwarded_to_the_kernel() -> None:
    request = ListSQLSchemasRequest(
        request_id=RequestId("schemas"),
        engine="warehouse",
        database="analytics",
        schema_path=["catalog"],
    )
    session_id = SessionId("00000000-0000-4000-8000-000000000001")
    session = MagicMock(session_id=session_id)
    sessions = MagicMock()
    sessions.get.return_value = session

    await list_sql_schemas(
        _context(sessions),
        protocol.ListSqlSchemas(
            notebook_uri=protocol.NotebookUri("file:///notebook.py"),
            kernel_session_id=protocol.KernelSessionId(str(session_id)),
            request_id="schemas",
            engine="warehouse",
            database="analytics",
            schema_path=["catalog"],
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
    session_id = SessionId("00000000-0000-4000-8000-000000000001")
    session = MagicMock(session_id=session_id)
    sessions = MagicMock()
    sessions.get.return_value = session

    await list_sql_tables(
        _context(sessions),
        protocol.ListSqlTables(
            notebook_uri=protocol.NotebookUri("file:///notebook.py"),
            kernel_session_id=protocol.KernelSessionId(str(session_id)),
            request_id="tables",
            engine="warehouse",
            database="analytics",
            schema="events",
            schema_path=["catalog", "events"],
        ),
    )

    session.put_control_request.assert_called_once_with(
        request.as_command(), from_consumer_id=None
    )


@pytest.mark.parametrize(
    ("handler", "command"),
    [
        (
            list_sql_schemas,
            protocol.ListSqlSchemas(
                notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
                kernel_session_id=protocol.KernelSessionId(
                    "00000000-0000-4000-8000-000000000001"
                ),
                request_id="schemas",
                engine="warehouse",
                database="analytics",
            ),
        ),
        (
            list_sql_tables,
            protocol.ListSqlTables(
                notebook_uri=protocol.NotebookUri(NOTEBOOK_URI),
                kernel_session_id=protocol.KernelSessionId(
                    "00000000-0000-4000-8000-000000000001"
                ),
                request_id="tables",
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
    command: protocol.ListSqlSchemas | protocol.ListSqlTables,
) -> None:
    sessions = MagicMock()
    sessions.get.return_value = None

    with pytest.raises(ValueError, match=f"No session found for {NOTEBOOK_URI}"):
        await handler(
            _context(sessions),
            command,
        )
