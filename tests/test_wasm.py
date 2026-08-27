# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

from unittest.mock import Mock

import msgspec
import pytest
from inline_snapshot import snapshot

from marimo_lsp.wasm import create_bridge


@pytest.mark.asyncio
async def test_wasm_server_handles_initialize_message() -> None:
    messages: list[object] = []
    server = create_bridge(
        lambda message: messages.append(msgspec.json.decode(message)),
        Mock(),
    )

    await server.handle_message(
        msgspec.json.encode(
            {
                "id": 1,
                "method": "initialize",
                "jsonrpc": "2.0",
                "params": {
                    "processId": None,
                    "rootUri": None,
                    "capabilities": {},
                },
            }
        ).decode()
    )

    assert messages == snapshot(
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "capabilities": {
                        "positionEncoding": "utf-16",
                        "textDocumentSync": {
                            "openClose": True,
                            "change": 2,
                            "save": False,
                        },
                        "completionProvider": {
                            "triggerCharacters": ["@"],
                            "resolveProvider": False,
                        },
                        "codeActionProvider": {
                            "codeActionKinds": ["refactor.rewrite"],
                            "resolveProvider": False,
                        },
                        "executeCommandProvider": {"commands": ["marimo.convert"]},
                        "diagnosticProvider": {
                            "interFileDependencies": False,
                            "workspaceDiagnostics": False,
                        },
                        "workspace": {
                            "workspaceFolders": {
                                "supported": True,
                                "changeNotifications": True,
                            },
                            "fileOperations": {},
                        },
                    },
                    "serverInfo": {"name": "marimo-lsp", "version": "0.1.0"},
                },
            }
        ]
    )
    server.close()


@pytest.mark.asyncio
async def test_wasm_server_drives_async_command_handler() -> None:
    messages: list[object] = []
    server = create_bridge(
        lambda message: messages.append(msgspec.json.decode(message)),
        Mock(),
    )

    await server.handle_message(
        msgspec.json.encode(
            {
                "id": 1,
                "method": "marimo/command",
                "jsonrpc": "2.0",
                "params": {"kind": "list-sessions"},
            }
        ).decode()
    )

    responses = [
        message
        for message in messages
        if isinstance(message, dict) and message.get("id") == 1
    ]
    assert responses == snapshot(
        [{"jsonrpc": "2.0", "id": 1, "result": {"sessions": []}}]
    )
    server.close()


def test_wasm_server_close_releases_tracked_kernels() -> None:
    server = create_bridge(Mock(), Mock())
    kernel = Mock()
    server._kernels._kernels["kernel"] = kernel

    server.close()
    server.close()

    kernel.close.assert_called_once_with()
