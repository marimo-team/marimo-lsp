"""Pure DAP server implementation without debugpy dependencies."""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, TYPE_CHECKING

from marimo_lsp.loggers import get_logger

if TYPE_CHECKING:
    from pygls.lsp.server import LanguageServer
    from marimo_lsp.session_manager import LspSessionManager

logger = get_logger()


class DAPMessageType(Enum):
    REQUEST = "request"
    RESPONSE = "response"
    EVENT = "event"


class DAPRequestType(Enum):
    INITIALIZE = "initialize"
    ATTACH = "attach"
    SET_BREAKPOINTS = "setBreakpoints"
    SET_EXCEPTION_BREAKPOINTS = "setExceptionBreakpoints"
    CONTINUE = "continue"
    STACK_TRACE = "stackTrace"
    VARIABLES = "variables"
    EVALUATE = "evaluate"
    THREADS = "threads"
    CONFIGURATION_DONE = "configurationDone"
    LAUNCH = "launch"
    DISCONNECT = "disconnect"
    PAUSE = "pause"
    STEP_IN = "stepIn"
    STEP_OUT = "stepOut"
    STEP_OVER = "next"
    SOURCES = "sources"
    SCOPES = "scopes"
    EXCEPTION_INFO = "exceptionInfo"


class DAPEventType(Enum):
    STOPPED = "stopped"
    BREAKPOINT = "breakpoint"
    INITIALIZED = "initialized"


@dataclass
class DAPMessage:
    seq: int
    type: DAPMessageType
    command: Optional[str] = None
    arguments: Optional[Dict[str, Any]] = None
    request_seq: Optional[int] = None
    success: Optional[bool] = None
    message: Optional[str] = None
    body: Optional[Dict[str, Any]] = None
    event: Optional[str] = None


@dataclass
class Breakpoint:
    line: int
    verified: bool = True
    message: Optional[str] = None


@dataclass
class DebugSession:
    session_id: str
    notebook_uri: str
    breakpoints: Dict[str, List[Breakpoint]] = None
    pdb_debugger: Optional[PDBDebugger] = None

    def __post_init__(self):
        if self.breakpoints is None:
            self.breakpoints = {}


class PDBDebugger:
    """Manages PDB subprocess for debugging marimo files."""
    
    def __init__(self, notebook_uri: str):
        self.notebook_uri = notebook_uri
        self.process: Optional[subprocess.Popen] = None
        self.temp_dir = tempfile.mkdtemp()
        self.breakpoints: Dict[int, bool] = {}
        self.current_line = 1
        self.is_running = False
        self.command_file = f"{self.temp_dir}/pdb_commands.txt"
        self.output_file = f"{self.temp_dir}/pdb_output.txt"
        
    async def start(self) -> bool:
        """Start PDB debugging session."""
        try:
            # Convert file URI to local path
            if self.notebook_uri.startswith("file://"):
                file_path = self.notebook_uri[7:]  # Remove file:// prefix
            else:
                file_path = self.notebook_uri
                
            # Create a custom PDB script that communicates via files
            debug_script = f"""
import pdb
import sys
import os
import traceback
from io import StringIO

class FilePdb(pdb.Pdb):
    def __init__(self, command_file, output_file):
        super().__init__(stdin=open(command_file, 'r'), stdout=open(output_file, 'w'))
        self.command_file = command_file
        self.output_file_path = output_file
        
    def do_continue(self, arg):
        with open(self.output_file_path, 'a') as f:
            f.write("CONTINUING\\n")
        return super().do_continue(arg)
        
    def do_step(self, arg):
        with open(self.output_file_path, 'a') as f:
            f.write("STEPPING\\n")
        return super().do_step(arg)
        
    def do_next(self, arg):
        with open(self.output_file_path, 'a') as f:
            f.write("NEXT\\n")
        return super().do_next(arg)
        
    def do_list(self, arg):
        with open(self.output_file_path, 'a') as f:
            f.write(f"CURRENT_LINE: {{self.curframe.f_lineno}}\\n")
        return super().do_list(arg)

# Initialize command and output files
with open("{self.command_file}", "w") as f:
    f.write("list\\n")
    
with open("{self.output_file}", "w") as f:
    f.write("PDB_STARTED\\n")

try:
    # Create custom debugger
    debugger = FilePdb("{self.command_file}", "{self.output_file}")
    
    # Run the marimo file under PDB
    debugger.run('exec(open("{file_path}").read())', globals(), locals())
    
except Exception as e:
    with open("{self.output_file}", "a") as f:
        f.write(f"ERROR: {{str(e)}}\\n")
        f.write(f"TRACEBACK: {{traceback.format_exc()}}\\n")
"""
            
            script_path = f"{self.temp_dir}/debug_session.py"
            with open(script_path, "w") as f:
                f.write(debug_script)
                
            # Initialize communication files
            with open(self.command_file, "w") as f:
                f.write("")
            with open(self.output_file, "w") as f:
                f.write("")
                
            # Start PDB process
            self.process = subprocess.Popen(
                ["/usr/bin/python3", script_path],
                cwd=self.temp_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            
            self.is_running = True
            logger.info(f"Started PDB debugger for {file_path}")
            
            # Wait briefly for startup
            await asyncio.sleep(0.1)
            return True
            
        except Exception as e:
            logger.error(f"Failed to start PDB: {e}")
            return False
    
    async def stop(self):
        """Stop PDB debugging session."""
        self.is_running = False
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
            self.process = None
            
        # Clean up temp files
        try:
            import shutil
            shutil.rmtree(self.temp_dir, ignore_errors=True)
        except Exception:
            pass
            
        logger.info("PDB session stopped")
    
    async def set_breakpoint(self, line: int) -> bool:
        """Set a breakpoint at the given line."""
        if not self.is_running:
            return False
            
        try:
            with open(self.command_file, "a") as f:
                f.write(f"break {line}\\n")
            self.breakpoints[line] = True
            logger.info(f"Set breakpoint at line {line}")
            return True
        except Exception as e:
            logger.error(f"Failed to set breakpoint: {e}")
            return False
    
    async def clear_breakpoint(self, line: int) -> bool:
        """Clear a breakpoint at the given line."""
        if not self.is_running:
            return False
            
        try:
            with open(self.command_file, "a") as f:
                f.write(f"clear {line}\\n")
            self.breakpoints.pop(line, None)
            logger.info(f"Cleared breakpoint at line {line}")
            return True
        except Exception as e:
            logger.error(f"Failed to clear breakpoint: {e}")
            return False
    
    async def continue_execution(self) -> bool:
        """Continue execution."""
        if not self.is_running:
            return False
            
        try:
            with open(self.command_file, "a") as f:
                f.write("continue\\n")
            return True
        except Exception as e:
            logger.error(f"Failed to continue: {e}")
            return False
    
    async def step_over(self) -> bool:
        """Step over the current line."""
        if not self.is_running:
            return False
            
        try:
            with open(self.command_file, "a") as f:
                f.write("next\\n")
            return True
        except Exception as e:
            logger.error(f"Failed to step over: {e}")
            return False
    
    async def step_into(self) -> bool:
        """Step into the current line."""
        if not self.is_running:
            return False
            
        try:
            with open(self.command_file, "a") as f:
                f.write("step\\n")
            return True
        except Exception as e:
            logger.error(f"Failed to step into: {e}")
            return False
    
    async def get_current_line(self) -> int:
        """Get the current line number."""
        if not self.is_running:
            return 1
            
        try:
            # Request current location
            with open(self.command_file, "a") as f:
                f.write("list\\n")
            
            # Read output (simplified for now)
            if os.path.exists(self.output_file):
                with open(self.output_file, "r") as f:
                    content = f.read()
                    # Look for CURRENT_LINE marker
                    for line in content.split("\\n"):
                        if line.startswith("CURRENT_LINE:"):
                            return int(line.split(":")[1].strip())
                            
        except Exception as e:
            logger.error(f"Failed to get current line: {e}")
            
        return self.current_line
    
    async def evaluate_expression(self, expression: str) -> str:
        """Evaluate an expression in the current context."""
        if not self.is_running:
            return f"Error: Debugger not running"
            
        try:
            with open(self.command_file, "a") as f:
                f.write(f"p {expression}\\n")
            
            # For now return a placeholder
            return f"Evaluated: {expression} (placeholder)"
            
        except Exception as e:
            logger.error(f"Failed to evaluate expression: {e}")
            return f"Error: {str(e)}"


class DAPServer:
    """Pure DAP server without debugpy dependencies."""
    
    def __init__(self, ls: LanguageServer, manager):
        self.ls = ls
        self.manager = manager
        self.debug_sessions: Dict[str, DebugSession] = {}
        self.message_seq = 0
        logger.info("Pure DAP server initialized")

    async def handle_dap_message(
        self, session_id: str, notebook_uri: str, message: Dict[str, Any]
    ) -> None:
        """Handle a DAP message."""
        logger.info(f"=== DAP REQUEST RECEIVED ===")
        logger.info(f"Session ID: {session_id}")
        logger.info(f"Notebook URI: {notebook_uri}")
        logger.info(f"Raw message: {message}")

        try:
            # Convert dict to DAPMessage
            msg_type = DAPMessageType(message.get("type", "request"))
            dap_message = DAPMessage(
                seq=message.get("seq", 0),
                type=msg_type,
                command=message.get("command"),
                arguments=message.get("arguments")
            )
            
            logger.info(f"Parsed request: {dap_message}")

            # Get or create debug session
            if session_id not in self.debug_sessions:
                self.debug_sessions[session_id] = DebugSession(
                    session_id=session_id,
                    notebook_uri=notebook_uri
                )
            
            session = self.debug_sessions[session_id]
            logger.info(f"Debug session: {session}")

            # Handle the request
            await self._handle_request(session_id, dap_message)

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

    async def _handle_request(self, session_id: str, message: DAPMessage) -> None:
        """Handle DAP requests."""
        command = message.command
        if not command:
            logger.warning("Received request with no command")
            await self._send_error_response(session_id, message, "No command specified")
            return

        logger.info(f"Handling DAP request: {command} (seq={message.seq})")
        
        try:
            if command == DAPRequestType.INITIALIZE.value:
                await self._handle_initialize(session_id, message)
            elif command == DAPRequestType.LAUNCH.value:
                await self._handle_launch(session_id, message)
            elif command == DAPRequestType.ATTACH.value:
                await self._handle_attach(session_id, message)
            elif command == DAPRequestType.SET_BREAKPOINTS.value:
                await self._handle_set_breakpoints(session_id, message)
            elif command == DAPRequestType.SET_EXCEPTION_BREAKPOINTS.value:
                await self._handle_set_exception_breakpoints(session_id, message)
            elif command == DAPRequestType.CONFIGURATION_DONE.value:
                await self._handle_configuration_done(session_id, message)
            elif command == DAPRequestType.THREADS.value:
                await self._handle_threads(session_id, message)
            elif command == DAPRequestType.STACK_TRACE.value:
                await self._handle_stack_trace(session_id, message)
            elif command == DAPRequestType.SCOPES.value:
                await self._handle_scopes(session_id, message)
            elif command == DAPRequestType.VARIABLES.value:
                await self._handle_variables(session_id, message)
            elif command == DAPRequestType.CONTINUE.value:
                await self._handle_continue(session_id, message)
            elif command == DAPRequestType.STEP_IN.value:
                await self._handle_step_in(session_id, message)
            elif command == DAPRequestType.STEP_OUT.value:
                await self._handle_step_out(session_id, message)
            elif command == DAPRequestType.STEP_OVER.value:
                await self._handle_step_over(session_id, message)
            elif command == DAPRequestType.EVALUATE.value:
                await self._handle_evaluate(session_id, message)
            elif command == DAPRequestType.DISCONNECT.value:
                await self._handle_disconnect(session_id, message)
            else:
                logger.warning(f"Unhandled DAP command: {command}")
                await self._send_error_response(session_id, message, f"Unknown command: {command}")
                
        except Exception as e:
            logger.error(f"Error handling DAP request {command}: {e}")
            await self._send_error_response(session_id, message, str(e))

    async def _handle_initialize(self, session_id: str, message: DAPMessage) -> None:
        """Handle initialize request."""
        logger.info("Handling initialize request")
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": True,
            "command": message.command,
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
                "supportsRestartFrame": True,
                "supportsDelayedStackTraceLoading": True,
                "supportsLoadedSourcesRequest": True,
                "supportsTerminateThreadsRequest": True,
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
                "supportsSingleThreadExecutionRequests": True,
            },
        }
        await self._send_dap_response(session_id, response)
        
        # Send initialized event
        await self._send_dap_event(session_id, {
            "type": "event",
            "event": "initialized"
        })

    async def _handle_launch(self, session_id: str, message: DAPMessage) -> None:
        """Handle launch request."""
        logger.info("Handling launch request")
        
        session = self.debug_sessions[session_id]
        
        # Start PDB debugger
        session.pdb_debugger = PDBDebugger(session.notebook_uri)
        success = await session.pdb_debugger.start()
        
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": success,
            "command": message.command,
        }
        await self._send_dap_response(session_id, response)

    async def _handle_attach(self, session_id: str, message: DAPMessage) -> None:
        """Handle attach request."""
        logger.info("Handling attach request")
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": True,
            "command": message.command,
        }
        await self._send_dap_response(session_id, response)

    async def _handle_set_breakpoints(self, session_id: str, message: DAPMessage) -> None:
        """Handle setBreakpoints request."""
        logger.info("Handling setBreakpoints request")
        args = message.arguments or {}
        source = args.get("source", {})
        path = source.get("path", "")
        breakpoints = args.get("breakpoints", [])

        # Store breakpoints for this file
        session = self.debug_sessions[session_id]
        session.breakpoints[path] = []
        verified_breakpoints = []
        
        for i, bp in enumerate(breakpoints):
            line = bp.get("line", 0)
            session.breakpoints[path].append(Breakpoint(line=line))
            
            # Set breakpoint in PDB if debugger is running
            success = True
            if session.pdb_debugger and session.pdb_debugger.is_running:
                success = await session.pdb_debugger.set_breakpoint(line)
            
            verified_breakpoints.append({
                "id": i, 
                "verified": success, 
                "line": line
            })

        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": True,
            "command": message.command,
            "body": {
                "breakpoints": verified_breakpoints
            },
        }
        await self._send_dap_response(session_id, response)

    async def _handle_set_exception_breakpoints(self, session_id: str, message: DAPMessage) -> None:
        """Handle setExceptionBreakpoints request."""
        logger.info("Handling setExceptionBreakpoints request")
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": True,
            "command": message.command,
            "body": {},
        }
        await self._send_dap_response(session_id, response)

    async def _handle_configuration_done(self, session_id: str, message: DAPMessage) -> None:
        """Handle configurationDone request."""
        logger.info("Handling configurationDone request")
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": True,
            "command": message.command,
        }
        await self._send_dap_response(session_id, response)

    async def _handle_threads(self, session_id: str, message: DAPMessage) -> None:
        """Handle threads request."""
        logger.info("Handling threads request")
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": True,
            "command": message.command,
            "body": {"threads": [{"id": 1, "name": "MainThread"}]},
        }
        await self._send_dap_response(session_id, response)

    async def _handle_stack_trace(self, session_id: str, message: DAPMessage) -> None:
        """Handle stackTrace request."""
        logger.info("Handling stackTrace request")
        session = self.debug_sessions[session_id]
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": True,
            "command": message.command,
            "body": {
                "stackFrames": [
                    {
                        "id": 1,
                        "name": "main",
                        "line": 1,
                        "column": 1,
                        "source": {
                            "name": session.notebook_uri.split("/")[-1],
                            "path": session.notebook_uri,
                        },
                    }
                ],
                "totalFrames": 1,
            },
        }
        await self._send_dap_response(session_id, response)

    async def _handle_scopes(self, session_id: str, message: DAPMessage) -> None:
        """Handle scopes request."""
        logger.info("Handling scopes request")
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": True,
            "command": message.command,
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
        await self._send_dap_response(session_id, response)

    async def _handle_variables(self, session_id: str, message: DAPMessage) -> None:
        """Handle variables request."""
        logger.info("Handling variables request")
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": True,
            "command": message.command,
            "body": {"variables": []},
        }
        await self._send_dap_response(session_id, response)

    async def _handle_continue(self, session_id: str, message: DAPMessage) -> None:
        """Handle continue request."""
        logger.info("Handling continue request")
        
        session = self.debug_sessions[session_id]
        success = True
        
        if session.pdb_debugger and session.pdb_debugger.is_running:
            success = await session.pdb_debugger.continue_execution()
        
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": success,
            "command": message.command,
            "body": {"allThreadsContinued": True},
        }
        await self._send_dap_response(session_id, response)

    async def _handle_step_in(self, session_id: str, message: DAPMessage) -> None:
        """Handle stepIn request."""
        logger.info("Handling stepIn request")
        
        session = self.debug_sessions[session_id]
        success = True
        
        if session.pdb_debugger and session.pdb_debugger.is_running:
            success = await session.pdb_debugger.step_into()
        
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": success,
            "command": message.command,
        }
        await self._send_dap_response(session_id, response)

    async def _handle_step_out(self, session_id: str, message: DAPMessage) -> None:
        """Handle stepOut request."""
        logger.info("Handling stepOut request")
        
        # Step out is not directly supported by PDB, so we'll just continue
        session = self.debug_sessions[session_id]
        success = True
        
        if session.pdb_debugger and session.pdb_debugger.is_running:
            success = await session.pdb_debugger.continue_execution()
        
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": success,
            "command": message.command,
        }
        await self._send_dap_response(session_id, response)

    async def _handle_step_over(self, session_id: str, message: DAPMessage) -> None:
        """Handle stepOver request."""
        logger.info("Handling stepOver request")
        
        session = self.debug_sessions[session_id]
        success = True
        
        if session.pdb_debugger and session.pdb_debugger.is_running:
            success = await session.pdb_debugger.step_over()
        
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": success,
            "command": message.command,
        }
        await self._send_dap_response(session_id, response)

    async def _handle_evaluate(self, session_id: str, message: DAPMessage) -> None:
        """Handle evaluate request."""
        logger.info("Handling evaluate request")
        args = message.arguments or {}
        expression = args.get("expression", "")

        session = self.debug_sessions[session_id]
        result = f"Evaluated: {expression}"
        
        if session.pdb_debugger and session.pdb_debugger.is_running:
            result = await session.pdb_debugger.evaluate_expression(expression)

        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": True,
            "command": message.command,
            "body": {
                "result": result,
                "type": "string",
                "variablesReference": 0,
            },
        }
        await self._send_dap_response(session_id, response)

    async def _handle_disconnect(self, session_id: str, message: DAPMessage) -> None:
        """Handle disconnect request."""
        logger.info("Handling disconnect request")
        
        # Clean up debug session
        if session_id in self.debug_sessions:
            session = self.debug_sessions[session_id]
            if hasattr(session, 'pdb_process') and session.pdb_process:
                session.pdb_process.terminate()
            del self.debug_sessions[session_id]

        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": True,
            "command": message.command,
        }
        await self._send_dap_response(session_id, response)

    async def _send_error_response(self, session_id: str, message: DAPMessage, error_message: str) -> None:
        """Send an error response."""
        response = {
            "type": "response",
            "request_seq": message.seq,
            "success": False,
            "command": message.command,
            "message": error_message,
        }
        await self._send_dap_response(session_id, response)

    async def _send_dap_response(self, session_id: str, response: Dict[str, Any]) -> None:
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


# Global DAP server instance
_dap_server: Optional[DAPServer] = None


def get_dap_server(ls: "LanguageServer", manager: "LspSessionManager") -> DAPServer:
    """Get the global DAP server instance."""
    global _dap_server
    if _dap_server is None:
        _dap_server = DAPServer(ls, manager)
    return _dap_server


async def handle_debug_adapter_request(
    ls: "LanguageServer",
    manager: "LspSessionManager",
    *,
    notebook_uri: str,
    session_id: str,
    message: dict,
) -> None:
    """Handle DAP requests using the pure DAP server."""
    logger.debug(f"Debug.Send {session_id=}, {message=}")

    # Get or create the DAP server
    dap_server = get_dap_server(ls, manager)

    # Handle the message
    await dap_server.handle_dap_message(session_id, notebook_uri, message)