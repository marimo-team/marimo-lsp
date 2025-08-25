"""Handler for DAP messages."""

from __future__ import annotations

import typing

import attrs
import cattrs

from marimo_lsp.loggers import get_logger

if typing.TYPE_CHECKING:
    from pygls.lsp.server import LanguageServer

    from marimo_lsp.session_manager import LspSessionManager

logger = get_logger()
converter = cattrs.Converter()


@attrs.define
class DapRequestMessage:
    """
    A generic DAP (Debug Adapter Protocol) request message.

    DAP requests follow a standard structure where the command field
    determines the action, and arguments contain command-specific parameters
    that require further parsing based on the command type.
    """

    seq: int
    """Sequence number of the message."""

    type: typing.Literal["request"]
    """Message type - always 'request' for DAP requests."""

    command: str
    """The command to execute (e.g., 'initialize', 'launch', 'setBreakpoints')."""

    arguments: dict | None
    """Command-specific arguments. Should be parsed further in ./debug_adapter.py"""


def handle_debug_adapter_request(
    ls: LanguageServer,
    manager: LspSessionManager,
    *,
    notebook_uri: str,
    session_id: str,
    message: dict,
) -> None:
    """Handle DAP requests."""
    request = converter.structure(message, DapRequestMessage)
    logger.debug(f"Debug.Send {session_id=}, {request=}")

    session = manager.get_session(notebook_uri)
    assert session, f"No session in workspace for {notebook_uri}"

    ls.protocol.notify(
        "marimo/dap",
        {
            "sessionId": session_id,
            "message": {
                "type": "response",
                "request_seq": request.seq,
                "success": True,
                "command": request.command,
                "request": {},
            },
        },
    )
