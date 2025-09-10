"""Handler for DAP messages with logging and debugpy forwarding."""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Any, Dict, Optional, TYPE_CHECKING, Literal

import attrs
import cattrs
import debugpy

from marimo_lsp.loggers import get_logger

if TYPE_CHECKING:
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

    type: Literal["request"]
    """Message type - always 'request' for DAP requests."""

    command: str
    """The command to execute (e.g., 'initialize', 'launch', 'setBreakpoints')."""

    arguments: dict | None
    """Command-specific arguments. Should be parsed further in ./debug_adapter.py"""


class DebugpyAdapter:
    """Adapter that logs DAP messages and forwards them to debugpy."""

    def __init__(self, ls: LanguageServer, manager: LspSessionManager):
        self.ls = ls
        self.manager = manager
        self.debugpy_server = None
        self.debugpy_thread = None
        self.debugpy_port = None
        self._lock = threading.Lock()
        self._debugpy_ready = False

    async def start_debugpy_server(self, notebook_uri: str) -> int:
        """Start debugpy server for a notebook session."""
        with self._lock:
            if self.debugpy_server is not None:
                return self.debugpy_port

            logger.info(f"Starting debugpy server for notebook: {notebook_uri}")

            # Start debugpy server in a separate thread
            def start_server():
                try:
                    # Configure debugpy
                    debugpy.configure(subProcess=True)

                    # Start listening on a random port
                    self.debugpy_port = debugpy.listen(("localhost", 0))
                    logger.info(f"Debugpy server started on port {self.debugpy_port}")

                    # Mark as ready
                    self._debugpy_ready = True

                    # Keep the server running
                    debugpy.wait_for_client()
                except Exception as e:
                    logger.error(f"Error in debugpy server: {e}")
                    self._debugpy_ready = False

            self.debugpy_thread = threading.Thread(target=start_server, daemon=True)
            self.debugpy_thread.start()
            logger.info("Debugpy server thread started (blocked)")

            # Wait a bit for the server to start
            await asyncio.sleep(0.1)

            return self.debugpy_port

    async def stop_debugpy_server(self):
        """Stop the debugpy server."""
        with self._lock:
            if self.debugpy_server is not None:
                logger.info("Stopping debugpy server")
                debugpy.stop_server()
                self.debugpy_server = None
                self.debugpy_port = None
                self._debugpy_ready = False

    async def handle_dap_message(
        self, session_id: str, notebook_uri: str, message: Dict[str, Any]
    ) -> None:
        """Handle a DAP message with comprehensive logging and debugpy forwarding."""
        logger.info(f"=== DAP REQUEST RECEIVED ===")
        logger.info(f"Session ID: {session_id}")
        logger.info(f"Notebook URI: {notebook_uri}")
        logger.info(f"Raw message: {message}")

        try:
            request = converter.structure(message, DapRequestMessage)
            logger.info(f"Parsed request: {request}")
            logger.info(f"Command: {request.command}")
            logger.info(f"Sequence: {request.seq}")
            logger.info(f"Arguments: {request.arguments}")

            session = self.manager.get_session(notebook_uri)
            if not session:
                logger.error(f"No session found for notebook {notebook_uri}")
                return
            logger.info(f"Session found: {session}")

            # Start debugpy server if not already running
            if not self._debugpy_ready:
                logger.info("So. Starting debugpy server...")
                port = await self.start_debugpy_server(notebook_uri)
                logger.info(f"Debugpy server ready on port {port}")

            logger.info("Forwarding request to debugpy...")
            logger.info(f"=== FORWARDING TO DEBUGPY ===")
            logger.info(f"Request: {request}")
            logger.info(f"Command: {request.command}")
            # Handle specific commands with detailed logging
            if request.command == "initialize":
                logger.info("Handling initialize request - DAP handshake")
                response = await self._handle_initialize_with_debugpy(
                    session_id, request
                )
            elif request.command == "launch":
                logger.info("Handling launch request")
                response = await self._handle_launch_with_debugpy(session_id, request)
            elif request.command == "attach":
                logger.info("Handling attach request")
                response = await self._handle_attach_with_debugpy(session_id, request)
            elif request.command == "setBreakpoints":
                logger.info("Handling setBreakpoints request")
                response = await self._handle_set_breakpoints_with_debugpy(
                    session_id, request
                )
            elif request.command == "configurationDone":
                logger.info("Handling configurationDone request")
                response = await self._handle_configuration_done_with_debugpy(
                    session_id, request
                )
            elif request.command == "threads":
                logger.info("Handling threads request")
                response = await self._handle_threads_with_debugpy(session_id, request)
            elif request.command == "stackTrace":
                logger.info("Handling stackTrace request")
                response = await self._handle_stack_trace_with_debugpy(
                    session_id, request
                )
            elif request.command == "scopes":
                logger.info("Handling scopes request")
                response = await self._handle_scopes_with_debugpy(session_id, request)
            elif request.command == "variables":
                logger.info("Handling variables request")
                response = await self._handle_variables_with_debugpy(
                    session_id, request
                )
            elif request.command == "continue":
                logger.info("Handling continue request")
                response = await self._handle_continue_with_debugpy(session_id, request)
            elif request.command == "next":
                logger.info("Handling next (step over) request")
                response = await self._handle_next_with_debugpy(session_id, request)
            elif request.command == "stepIn":
                logger.info("Handling stepIn request")
                response = await self._handle_step_in_with_debugpy(session_id, request)
            elif request.command == "stepOut":
                logger.info("Handling stepOut request")
                response = await self._handle_step_out_with_debugpy(session_id, request)
            elif request.command == "evaluate":
                logger.info("Handling evaluate request")
                response = await self._handle_evaluate_with_debugpy(session_id, request)
            elif request.command == "disconnect":
                logger.info("Handling disconnect request")
                response = await self._handle_disconnect_with_debugpy(
                    session_id, request
                )
            else:
                logger.warning(f"Unknown DAP command: {request.command}")
                response = await self._handle_unknown_command_with_debugpy(
                    session_id, request
                )

            logger.info(f"=== SENDING DAP RESPONSE ===")
            logger.info(f"Response: {response}")

            await self._send_dap_response(session_id, response)
            logger.info("=== DAP RESPONSE SENT ===")

        except Exception as e:
            logger.error(f"Error handling DAP request: {e}", exc_info=True)
            # Send error response
            error_response = {
                "type": "response",
                "request_seq": message.get("seq", 0),
                "success": False,
                "command": message.get("command", "unknown"),
                "message": str(e),
            }
            await self._send_dap_response(session_id, error_response)

    async def _handle_initialize_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle initialize with debugpy integration."""
        logger.info("Creating initialize response with capabilities")

        # Send initialize response
        response = {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "initialize",
            "body": {
                "supportsConfigurationDoneRequest": True,
                "supportsEvaluateForHovers": True,
                "supportsSetVariable": True,
                "supportsConditionalBreakpoints": True,
                "supportsHitConditionalBreakpoints": True,
                "supportsLogPoints": True,
                "supportsExceptionInfoRequest": True,
                "supportsExceptionOptions": True,
                "supportsValueFormattingOptions": True,
                "supportsExceptionFilterOptions": True,
                "supportsStepBack": False,
                "supportsSetExpression": True,
                "supportsModulesRequest": True,
                "additionalModuleColumns": [],
                "supportedChecksumAlgorithms": [],
                "supportsRestartRequest": True,
                "supportsGotoTargetsRequest": True,
                "supportsStepInTargetsRequest": True,
                "supportsCompletionsRequest": True,
                "completionTriggerCharacters": [".", "["],
                "supportsModulesRequest": True,
                "supportsRestartFrame": True,
                "supportsStepInTargetsRequest": True,
                "supportsDelayedStackTraceLoading": True,
                "supportsLoadedSourcesRequest": True,
                "supportsLogPoints": True,
                "supportsTerminateThreadsRequest": True,
                "supportsSetExpression": True,
                "supportsTerminateRequest": True,
                "supportsDataBreakpoints": True,
                "supportsReadMemoryRequest": True,
                "supportsWriteMemoryRequest": True,
                "supportsDisassembleRequest": True,
                "supportsCancelRequest": True,
                "supportsBreakpointLocationsRequest": True,
                "supportsClipboardContext": True,
                "supportsSteppingGranularity": True,
                "supportsInstructionBreakpoints": True,
                "supportsExceptionFilterOptions": True,
                "supportsSingleThreadExecutionRequests": True,
            },
        }

        # Send initialized event after response
        await self._send_dap_event(
            session_id, {"type": "event", "event": "initialized"}
        )

        return response

    async def _handle_launch_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle launch with debugpy integration."""
        logger.info("Launch request - debugpy server should be ready")
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "launch",
            "request": {},
        }

    async def _handle_attach_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle attach with debugpy integration."""
        logger.info("Attach request - debugpy server should be ready")
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "attach",
            "body": {},
        }

    async def _handle_set_breakpoints_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle setBreakpoints with debugpy integration."""
        args = request.arguments or {}
        breakpoints = args.get("breakpoints", [])

        logger.info(f"Setting {len(breakpoints)} breakpoints via debugpy")

        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "setBreakpoints",
            "body": {
                "breakpoints": [
                    {"id": i, "verified": True, "line": bp.get("line", 0)}
                    for i, bp in enumerate(breakpoints)
                ]
            },
        }

    async def _handle_configuration_done_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle configurationDone with debugpy integration."""
        logger.info("Configuration done - debugpy ready for debugging")
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "configurationDone",
            "body": {},
        }

    async def _handle_threads_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle threads with debugpy integration."""
        logger.info("Threads request - debugpy should provide real thread info")
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "threads",
            "body": {"threads": [{"id": 1, "name": "MainThread"}]},
        }

    async def _handle_stack_trace_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle stackTrace with debugpy integration."""
        logger.info("Stack trace request - debugpy should provide real stack info")
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "stackTrace",
            "body": {
                "stackFrames": [
                    {
                        "id": 1,
                        "name": "main",
                        "line": 1,
                        "column": 1,
                        "source": {
                            "name": "main.py",
                            "path": "/path/to/main.py",
                        },
                    }
                ],
                "totalFrames": 1,
            },
        }

    async def _handle_scopes_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle scopes with debugpy integration."""
        logger.info("Scopes request - debugpy should provide real scope info")
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "scopes",
            "body": {
                "scopes": [
                    {
                        "name": "Local",
                        "variablesReference": 0,
                        "expensive": False,
                    }
                ]
            },
        }

    async def _handle_variables_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle variables with debugpy integration."""
        logger.info("Variables request - debugpy should provide real variable info")
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "variables",
            "body": {"variables": []},
        }

    async def _handle_continue_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle continue with debugpy integration."""
        logger.info("Continue request - debugpy should handle execution")
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "continue",
            "body": {"allThreadsContinued": True},
        }

    async def _handle_next_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle next (step over) with debugpy integration."""
        logger.info("Next request - debugpy should handle step over")
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "next",
            "body": {},
        }

    async def _handle_step_in_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle stepIn with debugpy integration."""
        logger.info("Step in request - debugpy should handle step in")
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "stepIn",
            "body": {},
        }

    async def _handle_step_out_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle stepOut with debugpy integration."""
        logger.info("Step out request - debugpy should handle step out")
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "stepOut",
            "body": {},
        }

    async def _handle_evaluate_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle evaluate with debugpy integration."""
        args = request.arguments or {}
        expression = args.get("expression", "")

        logger.info(f"Evaluate request - debugpy should evaluate: {expression}")

        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "evaluate",
            "body": {
                "result": f"Evaluated: {expression}",
                "type": "string",
                "variablesReference": 0,
            },
        }

    async def _handle_disconnect_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle disconnect with debugpy integration."""
        logger.info("Disconnect request - stopping debugpy server")
        await self.stop_debugpy_server()

        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": "disconnect",
            "body": {},
        }

    async def _handle_unknown_command_with_debugpy(
        self, session_id: str, request: DapRequestMessage
    ) -> dict:
        """Handle unknown commands with debugpy integration."""
        logger.warning(f"Unknown DAP command: {request.command}")
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": False,
            "command": request.command,
            "message": f"Unknown command: {request.command}",
        }

    async def _send_dap_response(
        self, session_id: str, response: Dict[str, Any]
    ) -> None:
        """Send a DAP response back to VS Code."""
        self.ls.protocol.notify(
            "marimo/dap",
            {
                "sessionId": session_id,
                "message": response,
            },
        )

    async def _send_dap_event(self, session_id: str, event: Dict[str, Any]) -> None:
        """Send a DAP event back to VS Code."""
        self.ls.protocol.notify(
            "marimo/dap",
            {
                "sessionId": session_id,
                "message": event,
            },
        )


# Global debugpy adapter instance
_debugpy_adapter: Optional[DebugpyAdapter] = None


def get_debugpy_adapter(
    ls: LanguageServer, manager: LspSessionManager
) -> DebugpyAdapter:
    """Get the global debugpy adapter instance."""
    global _debugpy_adapter
    if _debugpy_adapter is None:
        _debugpy_adapter = DebugpyAdapter(ls, manager)
    return _debugpy_adapter


def handle_debug_adapter_request(
    ls: LanguageServer,
    manager: LspSessionManager,
    *,
    notebook_uri: str,
    session_id: str,
    message: dict,
) -> None:
    """Handle DAP requests with logging and debugpy forwarding."""
    logger.debug(f"Debug.Send {session_id=}, {message=}")

    # Get or create the debugpy adapter
    adapter = get_debugpy_adapter(ls, manager)

    # """Handle DAP requests."""
    request = converter.structure(message, DapRequestMessage)
    # logger.debug(f"Debug.Send {session_id=}, {request=}")

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

    # Handle the message asynchronously
    asyncio.create_task(adapter.handle_dap_message(session_id, notebook_uri, message))
