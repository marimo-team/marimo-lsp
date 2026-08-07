# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

from unittest.mock import Mock

import msgspec
from inline_snapshot import snapshot

from marimo_lsp.wasm import create_bridge


def test_wasm_server_handles_initialize_message() -> None:
    messages: list[object] = []
    server = create_bridge(
        lambda message: messages.append(msgspec.json.decode(message)),
        Mock(),
    )

    server.handle_message(
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
                        "executeCommandProvider": {
                            "commands": ["marimo.api", "marimo.convert"]
                        },
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
