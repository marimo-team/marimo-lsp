"""Minimal session manager for LSP integration."""

from __future__ import annotations

import typing
from uuid import uuid4

from marimo._config.manager import (
    get_default_config_manager,
)
from marimo._server.sessions import Session

from marimo_lsp.app_file_manager import LspAppFileManager
from marimo_lsp.kernel_manager import LspKernelManager
from marimo_lsp.loggers import get_logger
from marimo_lsp.session_consumer import LspSessionConsumer
from marimo_lsp.zeromq.queue_manager import ZeroMqQueueManager

if typing.TYPE_CHECKING:
    from marimo._server.file_manager import AppFileManager
    from marimo._server.sessions import KernelManager, QueueManager
    from pygls.lsp.server import LanguageServer


logger = get_logger()


class LspSessionManager:
    """Minimal session manager that maps notebook URIs to marimo sessions.

    This is a simplified session manager designed specifically for LSP integration.

    Unlike marimo's standard SessionManager, this one:
    - Uses notebook URIs as identifiers instead of session IDs
    - Has no authentication, resumption, or persistence features
    - Manages a simple dict of URI -> Session mappings
    """

    def __init__(self) -> None:
        """Initialize the session manager with an empty session map."""
        self._sessions: dict[str, Session] = {}

    def get_session(self, notebook_uri: str) -> Session | None:
        """Get a session by notebook URI."""
        return self._sessions.get(notebook_uri)

    def add_session(self, notebook_uri: str, session: Session) -> None:
        """Add a session to the manager."""
        logger.info(f"Adding session for {notebook_uri}")
        self._sessions[notebook_uri] = session

    def close_session(self, notebook_uri: str) -> None:
        """Close and remove a session."""
        session = self._sessions.pop(notebook_uri, None)
        if session:
            logger.info(f"Closing session for {notebook_uri}")
            try:
                session.close()
            except Exception:
                logger.exception(f"Error closing session for {notebook_uri}")

    def create_session(self, *, server: LanguageServer, notebook_uri: str) -> Session:
        """Create a new session for a notebook."""
        if notebook_uri in self._sessions:
            self.close_session(notebook_uri)

        app_file_manager = LspAppFileManager(server=server, notebook_uri=notebook_uri)
        config_manager = get_default_config_manager(current_path=app_file_manager.path)

        queue_manager, connection_info = ZeroMqQueueManager.create_host()

        kernel_manager = LspKernelManager(
            # TODO: Get executable
            executable="/Users/manzt/demos/marimo-lsp-test/.venv/bin/python",
            queue_manager=queue_manager,
            app_file_manager=app_file_manager,
            config_manager=config_manager,
            connection_info=connection_info,
        )

        logger.info(f"Creating new session for {notebook_uri}")

        session = Session(
            initialization_id=str(uuid4()),
            session_consumer=LspSessionConsumer(server, notebook_uri),
            queue_manager=typing.cast("QueueManager", queue_manager),
            kernel_manager=typing.cast("KernelManager", kernel_manager),
            app_file_manager=typing.cast("AppFileManager", app_file_manager),
            config_manager=config_manager,
            ttl_seconds=0,  # No TTL for LSP
        )

        self.add_session(notebook_uri, session)
        return session

    def shutdown(self) -> None:
        """Close all sessions during shutdown."""
        logger.info("Shutting down all sessions")
        uris = list(self._sessions.keys())
        for uri in uris:
            self.close_session(uri)
