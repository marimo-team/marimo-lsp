"""Handler for DAP messages."""

from __future__ import annotations

import asyncio
import base64
import json
import socket
import typing
import urllib.parse
from dataclasses import dataclass

import attrs
import cattrs
from marimo._ast.app import InternalApp
from marimo._ast.cell import CellImpl
from marimo._ast.load import _maybe_contents
from marimo._ast.parse import parse_notebook
from marimo._utils.cell_matching import match_cell_ids_by_similarity
from marimo._types.ids import CellId_t

from marimo_lsp.loggers import get_logger

try:
    import debugpy

    DEBUGPY_AVAILABLE = True
except ImportError:
    DEBUGPY_AVAILABLE = False

if typing.TYPE_CHECKING:
    from pygls.lsp.server import LanguageServer

    from marimo_lsp.session_manager import LspSessionManager

logger = get_logger()
converter = cattrs.Converter()


@dataclass
class DebugSession:
    """Tracks a debugpy server instance for a marimo session."""

    session_id: str
    port: int
    socket_connection: socket.socket | None = None
    is_connected: bool = False

    def cleanup(self) -> None:
        """Clean up the debug session."""
        if self.socket_connection:
            try:
                self.socket_connection.close()
            except Exception:
                pass
            self.socket_connection = None
        self.is_connected = False


class DebugSessionManager:
    """Manages debugpy servers for multiple marimo sessions."""

    def __init__(self) -> None:
        self._debug_sessions: dict[str, DebugSession] = {}

    def get_debug_session(self, session_id: str) -> DebugSession | None:
        """Get debug session by session ID."""
        return self._debug_sessions.get(session_id)

    def create_debug_session(self, session_id: str) -> DebugSession:
        """Create a new debug session with a debugpy server."""
        if session_id in self._debug_sessions:
            # Clean up existing session
            self._debug_sessions[session_id].cleanup()

        port = self._find_free_port()
        debug_session = DebugSession(session_id=session_id, port=port)
        self._debug_sessions[session_id] = debug_session

        logger.info(f"Created debug session {session_id} on port {port}")
        return debug_session

    def remove_debug_session(self, session_id: str) -> None:
        """Remove and clean up a debug session."""
        if session_id in self._debug_sessions:
            self._debug_sessions[session_id].cleanup()
            del self._debug_sessions[session_id]
            logger.info(f"Removed debug session {session_id}")

    def _find_free_port(self) -> int:
        """Find a free port for debugpy server."""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("", 0))
            s.listen(1)
            port = s.getsockname()[1]
        return port


# Global debug session manager
_debug_session_manager = DebugSessionManager()


def _parse_notebook_cell_uri(uri: str) -> tuple[str, str | None]:
    """Parse a VS Code notebook cell URI.

    Args:
        uri: URI like 'vscode-notebook-cell:/path/to/file.py#W3sZmlsZQ%3D%3D'

    Returns:
        Tuple of (file_path, cell_id_encoded) where cell_id_encoded is the fragment
    """
    if not uri.startswith("vscode-notebook-cell:"):
        return uri, None

    # Remove the scheme prefix
    path_with_fragment = uri[len("vscode-notebook-cell:") :]

    # Split on '#' to separate path from cell ID fragment
    if "#" in path_with_fragment:
        file_path, cell_fragment = path_with_fragment.rsplit("#", 1)
        return file_path, cell_fragment
    else:
        return path_with_fragment, None


def _get_cell_position_in_file(
    session, cell_uri: str, file_path: str
) -> tuple[int, int] | None:
    """Get the line and column offset of a cell in the full notebook file using similarity matching.

    Args:
        session: The marimo session
        cell_uri: The full VS Code cell URI (e.g., 'vscode-notebook-cell:/path/file.py#fragment')
        file_path: The actual file path to read and parse

    Returns:
        Tuple of (line_offset, col_offset) or None if not found
    """
    try:
        # Get cell data from session - cell IDs should be the full VS Code URIs
        app = session.app_file_manager.app

        # Find the cell URI in the session data using cell_manager
        cell_code = None
        logger.info(f"Looking for cell URI in session: {cell_uri}")

        # Use the cell_manager to find the cell
        cell_manager = app.cell_manager
        logger.info(f"Using cell_manager to find cell")

        # Get all cell IDs and codes
        cell_ids = list(cell_manager.cell_ids())

        logger.info(f"Available cell IDs: {cell_ids}")

        # Look for the cell URI in the cell IDs
        for cell_id in cell_ids:
            logger.info(f"Checking cell_id: {cell_id}")
            if str(cell_id) == cell_uri:
                # Get the code for this specific cell - will be a TextDocument in LSP context
                text_document = cell_manager.get_cell_code(cell_id)
                cell_code = text_document.source
                logger.info(
                    f"Found cell in session: ID={cell_id}, code length={len(cell_code)}"
                )
                break

        if not cell_code:
            logger.warning(f"Cell URI not found in cell_manager: {cell_uri}")
            return None

        # Read and parse the actual notebook file to get cell positions
        logger.info(f"Reading notebook file: {file_path}")

        try:
            # Use marimo's file loading utilities to parse the notebook
            contents = _maybe_contents(file_path)
            if not contents:
                logger.warning(f"Could not read file contents: {file_path}")
                return None

            notebook = parse_notebook(contents)
            if notebook is None or not notebook.valid:
                logger.warning(
                    f"Could not parse notebook or notebook invalid: {file_path}"
                )
                return None

            # Create cell mapping for similarity matching
            on_disk_cells = {}
            for i, cell in enumerate(notebook.cells):
                cell_id = CellId_t(str(i))
                on_disk_cells[cell_id] = cell.code

            logger.info(f"Found {len(on_disk_cells)} cells in notebook file")

            # Use marimo's similarity matching to find the cell
            # We need to create a mapping with a temporary cell ID for the cell we're looking for
            temp_cell_id = CellId_t("temp_cell")
            cells_to_match = {temp_cell_id: cell_code}

            matches = match_cell_ids_by_similarity(cells_to_match, on_disk_cells)

            if not matches or temp_cell_id not in matches:
                logger.warning(f"No similarity match found for cell")
                return None

            # Get the matched cell ID from the file
            matched_cell_id = matches[temp_cell_id]
            logger.info(f"Similarity match found: {matched_cell_id}")

            # Get the cell position from the parsed notebook
            cell_index = int(str(matched_cell_id))
            if 0 <= cell_index < len(notebook.cells):
                cell = notebook.cells[cell_index]
                line_offset = cell.lineno
                col_offset = cell.col_offset
                logger.info(
                    f"Found cell position: line={line_offset}, col={col_offset}"
                )
                return (line_offset, col_offset)
            else:
                logger.warning(f"Matched cell index out of range: {cell_index}")
                return None

        except Exception as e:
            logger.error(f"Failed to read/parse notebook file {file_path}: {e}")
            return None

    except Exception as e:
        logger.error(f"Failed to get cell position: {e}")
        return None


def _adjust_breakpoint_lines(
    breakpoint_lines: list[int], cell_line_offset: int
) -> list[int]:
    """Adjust breakpoint line numbers from cell-relative to file-relative.

    Args:
        breakpoint_lines: Line numbers relative to the cell (1-based)
        cell_line_offset: Line offset of the cell in the full file (0-based)

    Returns:
        List of adjusted line numbers (1-based, for DAP protocol)
    """
    # Convert cell-relative lines (1-based) to file-relative lines (1-based)
    # cell_line_offset is 0-based, so we add 1 to convert to 1-based, then add the relative line
    return [cell_line_offset + 1 + (line - 1) for line in breakpoint_lines]


def _start_debugpy_server(debug_session: DebugSession) -> bool:
    """Start a debugpy server for the given debug session."""
    if not DEBUGPY_AVAILABLE:
        logger.error("debugpy not available")
        return False

    try:
        logger.info(f"Starting debugpy server on localhost:{debug_session.port}")
        # Start debugpy listening on the assigned port
        debugpy.listen(("localhost", debug_session.port))
        logger.info(f"Successfully started debugpy server on port {debug_session.port}")

        # Check if debugpy is actually listening
        import time

        time.sleep(0.1)  # Give debugpy a moment to start
        logger.info(
            f"debugpy server should now be listening on localhost:{debug_session.port}"
        )
        return True
    except Exception as e:
        logger.error(
            f"Failed to start debugpy server on port {debug_session.port}: {e}"
        )
        return False


def enable_debugging_for_thread() -> None:
    """Enable debugging for the current thread. Call this from marimo's execution context."""
    if DEBUGPY_AVAILABLE:
        try:
            debugpy.debug_this_thread()
            logger.debug("Enabled debugging for current thread")
        except Exception as e:
            logger.warning(f"Failed to enable debugging for thread: {e}")


def enable_tracing_for_thread(should_trace: bool = True) -> None:
    """Enable/disable tracing for the current thread for performance optimization."""
    if DEBUGPY_AVAILABLE:
        try:
            debugpy.trace_this_thread(should_trace)
            logger.debug(f"Set tracing for current thread: {should_trace}")
        except Exception as e:
            logger.warning(f"Failed to set tracing for thread: {e}")


def _connect_to_debugpy(debug_session: DebugSession) -> bool:
    """Connect to the debugpy server via socket."""
    try:
        logger.info(
            f"Attempting to connect to debugpy server on localhost:{debug_session.port}"
        )
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5.0)  # 5 second timeout

        logger.info(f"Connecting socket to localhost:{debug_session.port}")
        sock.connect(("localhost", debug_session.port))

        debug_session.socket_connection = sock
        debug_session.is_connected = True
        logger.info(
            f"Successfully connected to debugpy server on port {debug_session.port}"
        )
        return True
    except ConnectionRefusedError as e:
        logger.error(
            f"Connection refused to debugpy server on port {debug_session.port}: {e}"
        )
        logger.error(
            "This usually means debugpy server is not running or not listening on the expected port"
        )
        return False
    except socket.timeout as e:
        logger.error(
            f"Timeout connecting to debugpy server on port {debug_session.port}: {e}"
        )
        return False
    except Exception as e:
        logger.error(
            f"Failed to connect to debugpy server on port {debug_session.port}: {e}"
        )
        return False


def _encode_dap_message(message_bytes: bytes) -> bytes:
    """Encode message bytes with DAP Content-Length header."""
    content_length = len(message_bytes)
    header = f"Content-Length: {content_length}\r\n\r\n"
    return header.encode("utf-8") + message_bytes


def _decode_dap_message(sock: socket.socket) -> bytes | None:
    """Read and decode a DAP message with Content-Length header."""
    try:
        # Read the Content-Length header
        header = b""
        while not header.endswith(b"\r\n\r\n"):
            chunk = sock.recv(1)
            if not chunk:
                return None
            header += chunk

        # Parse Content-Length
        header_str = header.decode("utf-8")
        content_length_line = [
            line
            for line in header_str.split("\r\n")
            if line.startswith("Content-Length:")
        ]
        if not content_length_line:
            return None

        content_length = int(content_length_line[0].split(":")[1].strip())

        # Read the message content
        content = b""
        while len(content) < content_length:
            chunk = sock.recv(content_length - len(content))
            if not chunk:
                return None
            content += chunk

        return content

    except Exception as e:
        logger.error(f"Failed to decode DAP message: {e}")
        return None


def _forward_dap_message(
    debug_session: DebugSession, raw_message_bytes: bytes, session_id: str
) -> dict | None:
    """Forward raw DAP message bytes to debugpy and return the parsed response."""
    if not debug_session.is_connected or not debug_session.socket_connection:
        logger.error(
            f"Debug session not connected: connected={debug_session.is_connected}, socket={debug_session.socket_connection is not None}"
        )
        return None

    try:
        logger.info(
            f"Sending {len(raw_message_bytes)} bytes to debugpy on port {debug_session.port}"
        )
        logger.debug(f"Raw message: {raw_message_bytes[:200]}...")

        # Encode with Content-Length header for debugpy
        encoded_message = _encode_dap_message(raw_message_bytes)
        logger.info(f"Encoded message length: {len(encoded_message)} bytes")

        # Send to debugpy
        bytes_sent = debug_session.socket_connection.send(encoded_message)
        logger.info(f"Sent {bytes_sent} bytes to debugpy")

        # Read exactly one response from debugpy - whatever it sends back
        logger.info("Waiting for response from debugpy...")
        response_bytes = _decode_dap_message(debug_session.socket_connection)

        if not response_bytes:
            logger.warning("No response received from debugpy")
            return None

        try:
            response = json.loads(response_bytes.decode("utf-8"))
            logger.info(f"Received response: {response}")
            return response

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse debugpy response as JSON: {e}")
            return None

    except Exception as e:
        logger.error(f"Failed to forward DAP message: {e}")
        logger.error(
            f"Socket state: connected={debug_session.is_connected}, port={debug_session.port}"
        )
        debug_session.is_connected = False
        return None


def _relay_dap_message(
    raw_message_bytes: bytes, request: DapRequestMessage, session_id: str
) -> dict:
    """Relay raw DAP message bytes to the appropriate debugpy server."""
    logger.info(f"Relaying DAP message: {request.command} to session {session_id}")

    if not DEBUGPY_AVAILABLE:
        return _create_error_response(request, "debugpy not available")

    debug_session = _debug_session_manager.get_debug_session(session_id)
    if not debug_session:
        return _create_error_response(request, "No debug session found")

    if not debug_session.is_connected:
        return _create_error_response(request, "Debug session not connected")

    # Forward message to debugpy and get parsed response
    response = _forward_dap_message(debug_session, raw_message_bytes, session_id)
    if response is None:
        return _create_error_response(request, "Failed to communicate with debugpy")

    return response


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

    arguments: dict | None = None
    """Command-specific arguments. Should be parsed further in ./debug_adapter.py"""


def _create_success_response(
    request: DapRequestMessage, body: dict | None = None
) -> dict:
    """Create a successful DAP response."""
    return {
        "type": "response",
        "request_seq": request.seq,
        "success": True,
        "command": request.command,
        "body": body or {},
    }


def _create_error_response(request: DapRequestMessage, message: str) -> dict:
    """Create an error DAP response."""
    return {
        "type": "response",
        "request_seq": request.seq,
        "success": False,
        "command": request.command,
        "message": message,
    }


def _send_error_response(
    ls: "LanguageServer", session_id: str, request: DapRequestMessage, message: str
) -> None:
    """Send an error response immediately."""
    ls.protocol.notify(
        "marimo/dap",
        {
            "sessionId": session_id,
            "message": _create_error_response(request, message),
        },
    )


def _handle_initialize(
    request: DapRequestMessage, ls: "LanguageServer", session_id: str
) -> dict:
    """Handle initialize request."""
    if not DEBUGPY_AVAILABLE:
        return _create_error_response(request, "debugpy not available")

    # Initialize debugpy
    try:
        debugpy.configure()

        # Return capabilities similar to what debugpy supports
        capabilities = {
            "supportsConfigurationDoneRequest": True,
            "supportsConditionalBreakpoints": True,
            "supportsHitConditionalBreakpoints": True,
            "supportsFunctionBreakpoints": False,
            "supportsSetVariable": True,
            "supportsEvaluateForHovers": True,
            "exceptionBreakpointFilters": [
                {
                    "filter": "raised",
                    "label": "Raised Exceptions",
                    "default": False,
                },
                {
                    "filter": "uncaught",
                    "label": "Uncaught Exceptions",
                    "default": True,
                },
            ],
        }

        # We'll send the initialized event after the response

        return _create_success_response(request, capabilities)
    except Exception as e:
        logger.error(f"Failed to initialize debugpy: {e}")
        return _create_error_response(request, f"Failed to initialize debugpy: {e}")


def _handle_launch(request: DapRequestMessage, session_id: str) -> dict:
    """Handle launch request - starts a debugpy server for this session."""
    if not DEBUGPY_AVAILABLE:
        return _create_error_response(request, "debugpy not available")

    try:
        # Create a new debug session with debugpy server
        debug_session = _debug_session_manager.create_debug_session(session_id)

        # Start the debugpy server
        if not _start_debugpy_server(debug_session):
            return _create_error_response(request, "Failed to start debugpy server")

        # For launch, we don't need to connect yet - just start the server
        # The client will connect to debugpy directly for DAP communication

        logger.info(
            f"Debug session launched for session {session_id} on port {debug_session.port}"
        )

        # Return simple success response - VS Code will handle the rest
        return {
            "type": "response",
            "request_seq": request.seq,
            "success": True,
            "command": request.command,
            "body": {},
        }

    except Exception as e:
        logger.error(f"Failed to launch debug session: {e}")
        return _create_error_response(request, f"Failed to launch: {e}")


def _handle_set_breakpoints(
    request: DapRequestMessage, session_id: str, session
) -> tuple[dict, bytes]:
    """Handle setBreakpoints request - transform notebook cell URIs to file paths.

    Returns:
        Tuple of (transformed_message_dict, transformed_message_bytes)
    """
    if not request.arguments:
        return {"error": "No arguments in setBreakpoints request"}, b""

    args = request.arguments.copy()
    source = args.get("source", {})

    # Parse the notebook cell URI
    original_path = source.get("path", "")
    logger.info(f"Original breakpoint path: {original_path}")

    file_path, cell_fragment = _parse_notebook_cell_uri(original_path)
    logger.info(f"Parsed file path: {file_path}, cell fragment: {cell_fragment}")

    # If it's not a notebook cell URI, pass through unchanged
    if not cell_fragment:
        transformed_message = {
            "seq": request.seq,
            "type": request.type,
            "command": request.command,
            "arguments": args,
        }
        return transformed_message, json.dumps(transformed_message).encode("utf-8")

    # For notebook cells, we need to transform the path and line numbers
    source["path"] = file_path

    # Get cell position in file using the original path as cell URI
    cell_position = _get_cell_position_in_file(session, original_path, file_path)

    if cell_position:
        line_offset, col_offset = cell_position
        logger.info(f"Found cell at line {line_offset}, column {col_offset}")

        # Adjust breakpoint line numbers
        if "lines" in args:
            original_lines = args["lines"]
            adjusted_lines = _adjust_breakpoint_lines(original_lines, line_offset)
            args["lines"] = adjusted_lines
            logger.info(f"Adjusted lines from {original_lines} to {adjusted_lines}")

        # Also adjust individual breakpoint entries
        if "breakpoints" in args:
            for breakpoint in args["breakpoints"]:
                if "line" in breakpoint:
                    original_line = breakpoint["line"]
                    adjusted_line = line_offset + 1 + (original_line - 1)
                    breakpoint["line"] = adjusted_line
                    logger.info(
                        f"Adjusted breakpoint line from {original_line} to {adjusted_line}"
                    )
    else:
        logger.warning(f"Could not find position for cell URI: {original_path}")
        # For now, let's still try to use the file path but keep original line numbers
        # This might not work perfectly but is better than failing completely

    transformed_message = {
        "seq": request.seq,
        "type": request.type,
        "command": request.command,
        "arguments": args,
    }

    logger.info(f"Transformed setBreakpoints message: {transformed_message}")
    return transformed_message, json.dumps(transformed_message).encode("utf-8")


def _handle_disconnect(
    request: DapRequestMessage, session_id: str, raw_message_bytes: bytes | None = None
) -> dict:
    """Handle disconnect request - cleans up the debug session."""
    if not DEBUGPY_AVAILABLE:
        return _create_error_response(request, "debugpy not available")

    try:
        # First try to relay disconnect to debugpy
        debug_session = _debug_session_manager.get_debug_session(session_id)
        if debug_session and debug_session.is_connected:
            # For disconnect, use raw bytes if available, otherwise construct message
            if raw_message_bytes:
                _relay_dap_message(raw_message_bytes, request, session_id)
            else:
                disconnect_message = {
                    "seq": request.seq,
                    "type": request.type,
                    "command": request.command,
                    "arguments": request.arguments or {},
                }
                message_bytes = json.dumps(disconnect_message).encode("utf-8")
                _relay_dap_message(message_bytes, request, session_id)

        # Clean up the debug session
        _debug_session_manager.remove_debug_session(session_id)

        logger.info(f"Disconnected debug session {session_id}")
        return _create_success_response(request)
    except Exception as e:
        logger.error(f"Failed to disconnect: {e}")
        return _create_error_response(request, f"Failed to disconnect: {e}")


async def handle_debug_adapter_request(
    ls: LanguageServer,
    manager: LspSessionManager,
    *,
    notebook_uri: str,
    session_id: str,
    message: dict,
    raw_message_bytes: bytes | None = None,
) -> None:
    """Handle DAP requests."""
    logger.info("=== DAP REQUEST RECEIVED ===")
    logger.info(f"Session ID: {session_id}")
    logger.info(f"Notebook URI: {notebook_uri}")
    logger.info(f"Raw message: {message}")

    request = converter.structure(message, DapRequestMessage)
    logger.info(
        f"Parsed request: command={request.command}, seq={request.seq}, args={request.arguments}"
    )

    session = manager.get_session(notebook_uri)
    if not session:
        # Try to create a session if it doesn't exist
        try:
            session = manager.create_session(server=ls, notebook_uri=notebook_uri)
            logger.info(f"Created new marimo session for debugging: {notebook_uri}")
        except Exception as e:
            logger.error(f"Failed to create session for {notebook_uri}: {e}")
            _send_error_response(
                ls, session_id, request, f"No session available for {notebook_uri}"
            )
            return

    if not DEBUGPY_AVAILABLE:
        _send_error_response(ls, session_id, request, "debugpy not available")
        return

    # Route commands to appropriate handlers
    logger.info(f"Routing command: {request.command}")

    if request.command == "initialize":
        logger.info("Handling initialize command directly")
        response = _handle_initialize(request, ls, session_id)
    elif request.command == "launch":
        logger.info("Handling launch command directly")
        response = _handle_launch(request, session_id)
    elif request.command == "disconnect":
        logger.info("Handling disconnect command directly")
        response = _handle_disconnect(request, session_id, raw_message_bytes)
    else:
        # For all other commands, relay to debugpy server
        logger.info(f"Relaying command {request.command} to debugpy server")

        # First ensure we're connected to the debugpy server
        debug_session = _debug_session_manager.get_debug_session(session_id)
        logger.info(f"Debug session found: {debug_session is not None}")

        if debug_session:
            logger.info(f"Debug session connected: {debug_session.is_connected}")
            if not debug_session.is_connected:
                logger.info("Attempting to connect to debugpy server...")
                if not _connect_to_debugpy(debug_session):
                    logger.error("Failed to connect to debugpy server")
                    response = _create_error_response(
                        request, "Failed to connect to debugpy server"
                    )
                else:
                    logger.info("Connected to debugpy server, relaying message")

                    # Check if this is a setBreakpoints command that needs transformation
                    if request.command == "setBreakpoints":
                        logger.info("Transforming setBreakpoints command")
                        transformed_message, transformed_bytes = (
                            _handle_set_breakpoints(request, session_id, session)
                        )
                        if "error" in transformed_message:
                            response = _create_error_response(
                                request, transformed_message["error"]
                            )
                        else:
                            response = _relay_dap_message(
                                transformed_bytes, request, session_id
                            )
                    else:
                        # Use raw bytes if available, otherwise encode the message dict
                        if raw_message_bytes:
                            response = _relay_dap_message(
                                raw_message_bytes, request, session_id
                            )
                        else:
                            message_bytes = json.dumps(message).encode("utf-8")
                            response = _relay_dap_message(
                                message_bytes, request, session_id
                            )
            else:
                logger.info("Already connected, relaying message")

                # Check if this is a setBreakpoints command that needs transformation
                if request.command == "setBreakpoints":
                    logger.info("Transforming setBreakpoints command")
                    transformed_message, transformed_bytes = _handle_set_breakpoints(
                        request, session_id, session
                    )
                    if "error" in transformed_message:
                        response = _create_error_response(
                            request, transformed_message["error"]
                        )
                    else:
                        response = _relay_dap_message(
                            transformed_bytes, request, session_id
                        )
                else:
                    # Use raw bytes if available, otherwise encode the message dict
                    if raw_message_bytes:
                        response = _relay_dap_message(
                            raw_message_bytes, request, session_id
                        )
                    else:
                        message_bytes = json.dumps(message).encode("utf-8")
                        response = _relay_dap_message(
                            message_bytes, request, session_id
                        )
        else:
            logger.error(f"No debug session found for session_id: {session_id}")
            response = _create_error_response(request, "No debug session found")

    logger.info(f"Sending response: {response}")
    ls.protocol.notify(
        "marimo/dap",
        {
            "sessionId": session_id,
            "message": response,
        },
    )
    logger.info("Response sent successfully")

    # Send initialized event after initialize response
    if request.command == "initialize" and response.get("success"):
        logger.info("Sending initialized event")
        await asyncio.sleep(0.1)  # Small delay to ensure response is processed first
        ls.protocol.notify(
            "marimo/dap",
            {
                "sessionId": session_id,
                "message": {"type": "event", "event": "initialized"},
            },
        )
        logger.info("Initialized event sent")
