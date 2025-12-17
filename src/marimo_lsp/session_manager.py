"""Minimal session manager for LSP integration."""

from __future__ import annotations

import typing
from uuid import uuid4

import marimo._ipc as ipc
from marimo._config.manager import (
    get_default_config_manager,
)
from marimo._server.sessions import Session

from marimo_lsp.app_file_manager import LspAppFileManager
from marimo_lsp.kernel_manager import LspKernelManager
from marimo_lsp.loggers import get_logger
from marimo_lsp.session_consumer import LspSessionConsumer

if typing.TYPE_CHECKING:
    from marimo._server.notebook import AppFileManager
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
        self._instantiated: dict[str, bool] = {}

    def get_session(self, notebook_uri: str) -> Session | None:
        """Get a session by notebook URI."""
        return self._sessions.get(notebook_uri)

    def add_session(self, notebook_uri: str, session: Session) -> None:
        """Add a session to the manager."""
        logger.info(f"Adding session for {notebook_uri}")
        self._sessions[notebook_uri] = session
        self._instantiated[notebook_uri] = False

    def close_session(self, notebook_uri: str) -> None:
        """Close and remove a session."""
        session = self._sessions.pop(notebook_uri, None)
        if session:
            logger.info(f"Closing session for {notebook_uri}")
            try:
                session.close()
            except Exception:
                logger.exception(f"Error closing session for {notebook_uri}")

        self._instantiated.pop(notebook_uri, None)

    def create_session(
        self, *, server: LanguageServer, notebook_uri: str, executable: str
    ) -> Session:
        """Create a new session for a notebook.

        Note: Sessions are created with (notebook_uri, executable) but only
        currently tracked by notebook_uri. This means changing Python interpreters
        won't automatically close the old session - it continues with the old
        interpreter until explicitly closed. We always close any existing
        session for the notebook_uri before creating a new one.
        """
        if notebook_uri in self._sessions:
            self.close_session(notebook_uri)

        queue_manager, connection_info = ipc.QueueManager.create()
        app_file_manager = LspAppFileManager(server=server, notebook_uri=notebook_uri)
        config_manager = get_default_config_manager(current_path=app_file_manager.path)

        kernel_manager = LspKernelManager(
            executable=executable,
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

    def is_instantiated(self, notebook_uri: str) -> bool:
        """Check if a session is instantiated."""
        return self._instantiated.get(notebook_uri, False)

    def set_instantiated(self, notebook_uri: str, *, instantiated: bool) -> None:
        """Set if a session is instantiated."""
        self._instantiated[notebook_uri] = instantiated
