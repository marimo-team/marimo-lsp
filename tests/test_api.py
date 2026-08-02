# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

from unittest.mock import MagicMock, patch

import msgspec
import pytest
from marimo._config.config import DEFAULT_CONFIG

from marimo_lsp.api import (
    ApiBuilder,
    ApiContext,
    get_configuration,
    update_configuration,
)
from marimo_lsp.models import (
    GetConfigurationRequest,
    NotebookCommand,
    SetDisplayThemeRequest,
    UpdateConfigurationRequest,
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
