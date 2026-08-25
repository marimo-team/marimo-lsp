# Copyright 2026 Marimo. All rights reserved.

"""Live kernel sessions owned by the language server."""

from __future__ import annotations

import asyncio
import json
import threading
import time
import typing
from typing import TYPE_CHECKING, cast
from uuid import uuid4

import msgspec
from marimo._config.manager import get_default_config_manager
from marimo._messaging.msgspec_encoder import asdict
from marimo._messaging.serde import (
    deserialize_kernel_message,
    deserialize_kernel_notification_name,
)
from marimo._runtime.commands import (
    CodeCompletionCommand,
    CommandMessage,
    CreateNotebookCommand,
    ExecuteCellCommand,
    HTTPRequest,
    UpdateCellConfigCommand,
    UpdateUIElementCommand,
    UpdateUserConfigCommand,
)
from marimo._session.state.session_view import SessionView
from marimo._types.ids import SessionId

from marimo_lsp.app_file_manager import LspAppFileManager, sync_app_with_workspace
from marimo_lsp.kernels import KernelOpenError
from marimo_lsp.loggers import get_logger
from marimo_lsp.models import (
    CellOutputReplay,
    KernelNotification,
    ListSessionsResponse,
    LiveCellReplay,
    ReadNotebookOutputsResponse,
    SavedCellReplay,
    SessionInfo,
)
from marimo_lsp.saved_session_writer import SavedSessionWriter
from marimo_lsp.saved_sessions import (
    decode_saved_session_outputs,
    decode_saved_session_view,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

    from marimo._ast.app import InternalApp
    from marimo._config.config import (
        MarimoConfig,
        PartialMarimoConfig,
        RuntimeConfig,
    )
    from marimo._config.manager import MarimoConfigManager
    from marimo._messaging.notification import NotificationMessage
    from marimo._messaging.types import KernelMessage
    from marimo._session.requests import InstantiateNotebookRequest
    from marimo._types.ids import ConsumerId
    from pygls.lsp.server import LanguageServer
    from pygls.workspace import Workspace

    from marimo_lsp.kernels import Kernel, Kernels
    from marimo_lsp.saved_session_store import SavedSessionFiles


logger = get_logger()

_MAX_CANCELLED_SCRATCHPAD_RUNS = 1024


def _raise_kernel_failure(_session: Session, error: str) -> None:
    """Turn a terminal failure before publication into a launch failure."""
    raise KernelOpenError(error)


def _notification_name(message: KernelMessage) -> str:
    """Best-effort op name of a kernel message, for logging only."""
    try:
        return deserialize_kernel_notification_name(message)
    except Exception:  # noqa: BLE001
        return "<undecodable>"


class _OperationSink:
    """Forward operations from one live kernel session."""

    def __init__(
        self,
        server: LanguageServer,
        notebook_uri: str,
        session_id: SessionId,
        *,
        activated: bool = True,
    ) -> None:
        self._server = server
        self._notebook_uri = notebook_uri
        self._session_id = session_id
        self._attached = True
        self._activated = activated
        self._pending: list[NotificationMessage] = []

    @property
    def attached(self) -> bool:
        return self._attached

    def attach(self) -> None:
        self._attached = True
        logger.info(f"Attached client for {self._notebook_uri}")

    def detach(self) -> None:
        self._attached = False
        self._pending.clear()
        logger.info(f"Detached client for {self._notebook_uri}")

    def activate(self) -> None:
        """Release operations after the session snapshot is visible."""
        if self._activated:
            return
        self._activated = True
        if not self._attached:
            self._pending.clear()
            return
        pending = self._pending
        self._pending = []
        for operation in pending:
            # Match notify(): one undeliverable notification must not fail
            # the start or restart that is releasing the backlog.
            try:
                self._forward(operation)
            except Exception:
                logger.exception(
                    "Dropped pending kernel notification (op=%s)", operation.name
                )

    def move(self, notebook_uri: str) -> None:
        """Route future operations to a renamed notebook."""
        self._notebook_uri = notebook_uri

    def notify(self, message: KernelMessage) -> None:
        if not self._attached:
            return

        try:
            notification = deserialize_kernel_message(message)
            if not self._activated:
                self._pending.append(notification)
                return
            self._forward(notification)
        except Exception:
            # A dropped message is invisible to the client; name the op so a
            # kernel emitting notifications this build cannot decode (e.g. a
            # newer user-env marimo) is diagnosable from the log.
            logger.exception(
                "Dropped undecodable kernel message (op=%s)",
                _notification_name(message),
            )

    def _forward(self, notification: NotificationMessage) -> None:
        self._server.protocol.notify(
            "marimo/kernelNotification",
            asdict(
                KernelNotification(
                    notebook_uri=self._notebook_uri,
                    session_id=self._session_id,
                    notification=notification,
                )
            ),
        )
        logger.debug(f"Forwarded {notification.name} to {self._notebook_uri}")


class Session:
    """One live marimo kernel session and its client attachment."""

    def __init__(  # noqa: PLR0913
        self,
        *,
        session_id: SessionId,
        notebook_uri: str,
        server: LanguageServer,
        kernel: Kernel,
        app_file_manager: LspAppFileManager,
        config_manager: MarimoConfigManager,
        on_change: typing.Callable[[], None] | None = None,
        session_view: SessionView | None = None,
        saved_session_files: SavedSessionFiles | None = None,
        started_at: float | None = None,
    ) -> None:
        self.session_id = session_id
        self._notebook_uri = notebook_uri
        self._app_file_manager = app_file_manager
        self._config_manager = config_manager
        # Used by exporters and scratchpad snapshots.
        self.session_view = session_view if session_view is not None else SessionView()

        self._operation_sink = _OperationSink(
            server,
            notebook_uri,
            session_id,
            activated=False,
        )
        self._closed = False
        self._runtime_config = config_manager.get_config(hide_secrets=False)
        self.started_at = started_at if started_at is not None else time.time()
        self._status: typing.Literal["idle", "running"] = "idle"
        self._idle = asyncio.Event()
        self._idle.set()
        self._scratchpad_running = False
        self._scratchpad_run_id: str | None = None
        self._on_change = on_change or (lambda: None)
        self._on_kernel_failure: typing.Callable[[Session, str], None] = (
            lambda _session, _error: None
        )
        self._state_lock = threading.RLock()

        self._kernel = kernel
        self._instantiated = False
        self._saved_session_writer = None
        if (
            saved_session_files is not None
            and kernel.marimo_version is not None
            and kernel.session_cache_path is not None
        ):
            self._saved_session_writer = SavedSessionWriter(
                view=self.session_view,
                app_file_manager=self._app_file_manager,
                marimo_version=kernel.marimo_version,
                target=kernel.session_cache_path,
                files=saved_session_files,
            )
        logger.info(f"Started session {session_id}")

    @property
    def executable(self) -> str:
        """Return the Python executable used by this session."""
        return self._kernel.executable

    @property
    def working_directory(self) -> str:
        """Return the configured kernel working directory."""
        return self._kernel.working_directory

    @property
    def attached(self) -> bool:
        """Return whether operations are forwarded to the notebook client."""
        return self._operation_sink.attached

    @property
    def app(self) -> InternalApp:
        """Return the live marimo app state."""
        return self._app_file_manager.app

    @property
    def filename(self) -> str | None:
        """Return the notebook filename, when it has one."""
        return self._app_file_manager.filename

    @property
    def app_file_manager(self) -> LspAppFileManager:
        """Return the app state used to build a replacement kernel."""
        return self._app_file_manager

    @property
    def config_manager(self) -> MarimoConfigManager:
        """Return the configuration used to build a replacement kernel."""
        return self._config_manager

    def get_config(self, *, hide_secrets: bool = True) -> MarimoConfig:
        """Return this session's configured marimo settings."""
        return self._config_manager.get_config(hide_secrets=hide_secrets)

    def save_config(self, config: PartialMarimoConfig) -> MarimoConfig:
        """Persist configuration and apply its effective runtime value."""
        updated = self._config_manager.save_config(config)
        self.update_runtime_config(updated)
        return updated

    def output_replay(self) -> list[CellOutputReplay]:
        """Project the authoritative live view for a newly attached client."""
        codes = self._app_file_manager.app.cell_manager.code_map()
        cells: list[CellOutputReplay] = []
        for cell_id, notification in self.session_view.cell_notifications.items():
            if cell_id not in codes:
                continue
            if (
                notification.output is None
                and not notification.console
                and notification.status not in {"queued", "running"}
            ):
                continue
            executed_source = self.session_view.last_executed_code.get(cell_id)
            stale = notification.stale_inputs is True or (
                executed_source != codes[cell_id]
            )
            cells.append(
                LiveCellReplay(
                    notification=msgspec.structs.replace(
                        notification,
                        stale_inputs=stale,
                    ),
                    executed_source=executed_source,
                )
            )
        return cells

    def sync(self, workspace: Workspace) -> None:
        """Synchronize the live app with the current notebook document."""
        previous_configs = {
            cell_id: config.asdict()
            for cell_id, config in self._app_file_manager.app.cell_manager.config_map().items()
        }
        sync_app_with_workspace(
            workspace=workspace,
            notebook_uri=self._notebook_uri,
            app=self._app_file_manager.app,
        )
        self._app_file_manager.sync_header(workspace)
        current_configs = {
            cell_id: config.asdict()
            for cell_id, config in self._app_file_manager.app.cell_manager.config_map().items()
        }
        changed_configs = {
            cell_id: config
            for cell_id, config in current_configs.items()
            if previous_configs.get(cell_id) != config
        }
        # marimo 0.23.16 only schedules the stale closure from the last
        # enabled cell in a batched UpdateCellConfigCommand. Forward each
        # change separately so every newly enabled cell is considered.
        for cell_id, config in changed_configs.items():
            self.put_control_request(
                UpdateCellConfigCommand(configs={cell_id: config}),
                from_consumer_id=None,
            )

    def accept_kernel_message(self, message: KernelMessage) -> None:
        """Record and forward an operation received from the kernel."""
        if self._closed:
            return
        self.session_view.add_raw_notification(message)
        kernel_error = self._update_status(message)
        self._operation_sink.notify(message)
        if kernel_error is not None:
            self._on_kernel_failure(self, kernel_error)

    def _update_status(self, message: KernelMessage) -> str | None:
        try:
            operation = json.loads(message)
        except json.JSONDecodeError:
            return None

        if operation.get("op") == "completed-run":
            self._complete_run(operation.get("run_id"))
        elif operation.get("op") == "cell-op" and operation.get("status") in {
            "queued",
            "running",
        }:
            self._set_status("running")
        elif operation.get("op") == "kernel-startup-error":
            return str(operation.get("error", "Kernel bridge failed"))
        return None

    def _set_status(self, status: typing.Literal["idle", "running"]) -> None:
        with self._state_lock:
            if self._status == status:
                return
            self._status = status
            if status == "idle":
                self._idle.set()
            else:
                self._idle.clear()
        self._on_change()

    def _complete_run(self, run_id: str | None) -> None:
        with self._state_lock:
            if self._scratchpad_running:
                if self._scratchpad_run_id != run_id:
                    return
                self._scratchpad_running = False
                self._scratchpad_run_id = None
            if self._status == "idle":
                return
            self._status = "idle"
            self._idle.set()
        self._on_change()

    def mark_running(self) -> None:
        """Mark the session busy before sending an execution request."""
        self._set_status("running")

    async def wait_until_idle(self) -> bool:
        """Wait until this live session can accept another execution."""
        await self._idle.wait()
        with self._state_lock:
            return not self._closed

    def try_start_scratchpad(self, run_id: str | None) -> bool:
        """Claim an idle session for one scratchpad run without yielding."""
        with self._state_lock:
            if self._closed or self._status != "idle":
                return False
            self._scratchpad_running = True
            self._scratchpad_run_id = run_id
            self._status = "running"
            self._idle.clear()
        self._on_change()
        return True

    def is_scratchpad_running(self, run_id: str) -> bool:
        """Return whether the correlated scratchpad currently owns the kernel."""
        with self._state_lock:
            return self._scratchpad_running and self._scratchpad_run_id == run_id

    def release_scratchpad(self, run_id: str | None) -> None:
        """Release a scratchpad claim when dispatch fails before reaching the kernel."""
        self._complete_run(run_id)

    def describe(self) -> SessionInfo:
        """Return the public snapshot for this live session."""
        with self._state_lock:
            return SessionInfo(
                session_id=self.session_id,
                notebook_uri=self._notebook_uri,
                filename=self.filename,
                executable=self.executable,
                working_directory=self.working_directory,
                started_at=self.started_at,
                status=self._status,
                attached=self.attached,
            )

    def set_on_change(self, on_change: typing.Callable[[], None]) -> None:
        """Install the callback after the session joins its owning collection."""
        with self._state_lock:
            self._on_change = on_change

    def set_on_kernel_failure(
        self,
        on_kernel_failure: typing.Callable[[Session, str], None],
    ) -> None:
        """Install the callback for a terminal kernel transport failure."""
        with self._state_lock:
            self._on_kernel_failure = on_kernel_failure

    def put_input(self, text: str) -> None:
        """Send user input to the kernel's stdin."""
        self._kernel.input(text)

    def try_interrupt(self) -> None:
        """Interrupt the kernel."""
        self._kernel.interrupt()

    def put_control_request(
        self,
        request: CommandMessage,
        from_consumer_id: ConsumerId | None,
    ) -> None:
        """Send a command to the kernel."""
        del from_consumer_id
        if not isinstance(request, CodeCompletionCommand):
            self.session_view.add_control_request(request)
        self._kernel.send(request)

    def _effective_runtime(self, config: MarimoConfig) -> MarimoConfig:
        if self.attached:
            return config

        runtime = cast("RuntimeConfig", config.get("runtime", {}))
        return cast(
            "MarimoConfig",
            {**config, "runtime": {**runtime, "auto_reload": "off"}},
        )

    def update_runtime_config(self, config: MarimoConfig) -> None:
        """Apply configuration subject to this session's attachment policy."""
        self._runtime_config = config
        self.put_control_request(
            UpdateUserConfigCommand(config=self._effective_runtime(config)),
            from_consumer_id=None,
        )

    def detach(self, *, notify: bool = True) -> None:
        """Detach the client and pause auto-reload without stopping the kernel."""
        if not self.attached:
            return

        self._operation_sink.detach()
        self.update_runtime_config(self._runtime_config)
        if notify:
            self._on_change()

    def attach(self, *, notify: bool = True) -> None:
        """Reattach the client and restore the configured auto-reload mode."""
        if self.attached:
            return

        self._operation_sink.attach()
        self.update_runtime_config(self._runtime_config)
        if notify:
            self._on_change()

    def move(self, notebook_uri: str, *, notify: bool = True) -> None:
        """Move this session to a renamed notebook URI."""
        with self._state_lock:
            self._notebook_uri = notebook_uri
            self._operation_sink.move(notebook_uri)
            self._app_file_manager.move(notebook_uri)
            # The target belongs to the filename reported at kernel startup.
            if self._saved_session_writer is not None:
                self._saved_session_writer.stop()
                self._saved_session_writer = None
        if notify:
            self._on_change()

    def instantiate(
        self,
        request: InstantiateNotebookRequest,
        *,
        http_request: HTTPRequest | None,
    ) -> None:
        """Instantiate the notebook."""
        if self._instantiated:
            return
        codes = request.codes or self._app_file_manager.app.cell_manager.code_map()

        del http_request  # Unused in language-server sessions.

        self.put_control_request(
            CreateNotebookCommand(
                execution_requests=tuple(
                    ExecuteCellCommand(cell_id=cell_id, code=code)
                    for cell_id, code in codes.items()
                ),
                set_ui_element_value_request=UpdateUIElementCommand(
                    object_ids=request.object_ids,
                    values=request.values,
                ),
                auto_run=request.auto_run,
                cell_ids=tuple(codes.keys()),
            ),
            from_consumer_id=None,
        )
        self._instantiated = True
        if self._saved_session_writer is not None:
            self._saved_session_writer.start()

    def activate(self) -> None:
        """Release operations after this session becomes authoritative."""
        self._operation_sink.activate()

    def close(self) -> None:
        """Close the session and its owned kernel resources."""
        if self._closed:
            return
        self._closed = True
        self._idle.set()
        self._on_change = lambda: None
        logger.info(f"Closing session {self.session_id}")
        if self._saved_session_writer is not None:
            self._saved_session_writer.stop()
        self._kernel.close()
        self._operation_sink.detach()


class Sessions:
    """The language server's collection of live kernel sessions."""

    def __init__(
        self,
        server: LanguageServer,
        *,
        kernels: Kernels,
        saved_session_files: SavedSessionFiles | None = None,
    ) -> None:
        self._server = server
        self._kernels = kernels
        self._saved_session_files = saved_session_files
        self._sessions: dict[str, Session] = {}
        self._lock = threading.RLock()
        self._lifecycle_locks: dict[str, asyncio.Lock] = {}
        self._lifecycle_versions: dict[str, int] = {}
        # A bounded set of cancellation tombstones closes the race where a
        # run-correlated interrupt is handled before execute-scratchpad reaches
        # session startup. Run ids are unique, so late tombstones are harmless.
        self._cancelled_scratchpad_runs: dict[tuple[str, str], None] = {}

    def _lifecycle_lock(self, notebook_uri: str) -> asyncio.Lock:
        with self._lock:
            return self._lifecycle_locks.setdefault(notebook_uri, asyncio.Lock())

    def _lifecycle_version(self, notebook_uri: str) -> int:
        with self._lock:
            return self._lifecycle_versions.get(notebook_uri, 0)

    def _invalidate_lifecycle(self, notebook_uri: str) -> None:
        self._lifecycle_versions[notebook_uri] = (
            self._lifecycle_versions.get(notebook_uri, 0) + 1
        )

    def __iter__(self) -> Iterator[Session]:
        """Iterate over the live sessions."""
        with self._lock:
            return iter(tuple(self._sessions.values()))

    def describe(self) -> list[SessionInfo]:
        """Return newest-first public descriptions of all live sessions."""
        return sorted(
            (session.describe() for session in self),
            key=lambda session: session.started_at,
            reverse=True,
        )

    def _notify_changed(self) -> None:
        # Kernel listener threads can report status concurrently with LSP
        # lifecycle requests. Serialize snapshot construction and delivery so
        # notifications never observe a partially mutated collection.
        with self._lock:
            self._server.protocol.notify(
                "marimo/sessionsChanged",
                msgspec.to_builtins(ListSessionsResponse(sessions=self.describe())),
            )

    def get(self, notebook_uri: str) -> Session | None:
        """Return the live session for a notebook, if one exists."""
        with self._lock:
            return self._sessions.get(notebook_uri)

    async def read_notebook_outputs(
        self,
        notebook_uri: str,
        *,
        session_cache_path: str | None,
    ) -> ReadNotebookOutputsResponse:
        """Prefer a live SessionView and otherwise decode the supplied cache."""
        session = self.get(notebook_uri)
        if session is not None:
            return ReadNotebookOutputsResponse(cells=session.output_replay())
        if self._saved_session_files is None or session_cache_path is None:
            return ReadNotebookOutputsResponse(cells=[])

        try:
            app_file_manager = LspAppFileManager(
                server=self._server,
                notebook_uri=notebook_uri,
            )
            contents = await self._saved_session_files.read(session_cache_path)
            # A session created while the file was being read is authoritative.
            session = self.get(notebook_uri)
            if session is not None:
                return ReadNotebookOutputsResponse(cells=session.output_replay())
            if contents is None:
                return ReadNotebookOutputsResponse(cells=[])
            cells = app_file_manager.app.cell_manager
            notifications = decode_saved_session_outputs(
                contents,
                codes=cells.codes(),
                cell_ids=cells.cell_ids(),
                header=app_file_manager.header,
            )
            return ReadNotebookOutputsResponse(
                cells=[
                    SavedCellReplay(notification=notification)
                    for notification in notifications
                ]
            )
        except Exception:
            logger.exception("Ignored unreadable saved session")
            return ReadNotebookOutputsResponse(cells=[])

    def cancel_scratchpad(self, notebook_uri: str, run_id: str) -> None:
        """Remember a cancellation and interrupt only its active scratchpad."""
        key = (notebook_uri, run_id)
        with self._lock:
            self._cancelled_scratchpad_runs[key] = None
            while len(self._cancelled_scratchpad_runs) > _MAX_CANCELLED_SCRATCHPAD_RUNS:
                oldest = next(iter(self._cancelled_scratchpad_runs))
                del self._cancelled_scratchpad_runs[oldest]
            session = self._sessions.get(notebook_uri)
        if session is not None and session.is_scratchpad_running(run_id):
            session.try_interrupt()

    def take_scratchpad_cancellation(self, notebook_uri: str, run_id: str) -> bool:
        """Consume a pending cancellation for one scratchpad run."""
        key = (notebook_uri, run_id)
        with self._lock:
            if key not in self._cancelled_scratchpad_runs:
                return False
            del self._cancelled_scratchpad_runs[key]
            return True

    async def start(
        self,
        notebook_uri: str,
        executable: str,
        working_directory: str,
    ) -> Session:
        """Start or reuse the notebook's session.

        A different executable replaces the existing session only after the
        replacement has started successfully.
        """
        async with self._lifecycle_lock(notebook_uri):
            current = self.get(notebook_uri)
            if current is not None and current.executable == executable:
                current.attach()
                return current

            version = self._lifecycle_version(notebook_uri)
            replacement = await self._create(
                notebook_uri, executable, working_directory
            )
            with self._lock:
                if version != self._lifecycle_version(notebook_uri):
                    superseded = True
                else:
                    superseded = False
                    self._sessions[notebook_uri] = replacement
                    replacement.set_on_change(self._notify_changed)
                    replacement.set_on_kernel_failure(self._kernel_failed)
            if superseded:
                self._close(replacement, notebook_uri)
                message = (
                    f"Session changed while its kernel was starting: {notebook_uri}"
                )
                raise KernelOpenError(message)
            if current is not None:
                self._close(current, notebook_uri)
            self._notify_changed()
            replacement.activate()
            return replacement

    async def _create(  # noqa: C901
        self,
        notebook_uri: str,
        executable: str,
        working_directory: str,
        *,
        previous: Session | None = None,
    ) -> Session:
        app_file_manager = previous.app_file_manager if previous else None
        config_manager = previous.config_manager if previous else None
        if app_file_manager is None:
            app_file_manager = LspAppFileManager(
                server=self._server,
                notebook_uri=notebook_uri,
            )
        if config_manager is None:
            config_manager = get_default_config_manager(
                current_path=app_file_manager.path
            )
        session_id = SessionId(str(uuid4()))
        pending_messages: list[KernelMessage] = []
        session: Session | None = None
        loop = asyncio.get_running_loop()

        def deliver(message: KernelMessage) -> None:
            if session is None:
                pending_messages.append(message)
            else:
                session.accept_kernel_message(message)

        def receive(message: KernelMessage) -> None:
            # Kernel adapters may deliver from another thread. Serialize all
            # state updates and language-server notifications on the LSP loop.
            loop.call_soon_threadsafe(deliver, message)

        logger.info(f"Starting session for {notebook_uri}")
        kernel = await self._kernels.launch(
            executable=executable,
            app_file_manager=app_file_manager,
            config_manager=config_manager,
            working_directory=working_directory,
            receive=receive,
        )
        try:
            session_view = previous.session_view if previous else None
            if (
                session_view is None
                and self._saved_session_files is not None
                and kernel.marimo_version is not None
                and kernel.session_cache_path is not None
            ):
                try:
                    contents = await self._saved_session_files.read(
                        kernel.session_cache_path
                    )
                    if contents is not None:
                        cells = app_file_manager.app.cell_manager
                        session_view = decode_saved_session_view(
                            contents,
                            codes=cells.codes(),
                            cell_ids=cells.cell_ids(),
                            marimo_version=kernel.marimo_version,
                            header=app_file_manager.header,
                        )
                except Exception:
                    logger.exception("Ignored unreadable saved session")
            session = Session(
                session_id=session_id,
                notebook_uri=notebook_uri,
                server=self._server,
                kernel=kernel,
                app_file_manager=app_file_manager,
                config_manager=config_manager,
                session_view=session_view,
                saved_session_files=self._saved_session_files,
                started_at=previous.started_at if previous else None,
            )
            session.set_on_kernel_failure(_raise_kernel_failure)
            for message in pending_messages:
                session.accept_kernel_message(message)
            pending_messages.clear()
        except BaseException:
            try:
                if session is None:
                    kernel.close()
                else:
                    session.close()
            except Exception:
                logger.exception("Error closing kernel after session creation failed")
            raise
        return session

    async def restart(
        self,
        notebook_uri: str,
        *,
        executable: str,
        working_directory: str,
        create_if_missing: bool = False,
    ) -> Session | None:
        """Atomically replace a live session's kernel."""
        async with self._lifecycle_lock(notebook_uri):
            current = self.get(notebook_uri)
            if current is None and not create_if_missing:
                return None

            version = self._lifecycle_version(notebook_uri)
            if current is None:
                replacement = await self._create(
                    notebook_uri, executable, working_directory
                )
            else:
                replacement = await self._create(
                    notebook_uri,
                    current.executable,
                    current.working_directory,
                    previous=current,
                )
                if not current.attached:
                    replacement.detach(notify=False)

            with self._lock:
                if version != self._lifecycle_version(notebook_uri):
                    superseded = True
                else:
                    superseded = False
                    self._sessions[notebook_uri] = replacement
                    replacement.set_on_change(self._notify_changed)
                    replacement.set_on_kernel_failure(self._kernel_failed)
            if superseded:
                self._close(replacement, notebook_uri)
                message = (
                    f"Session changed while its kernel was starting: {notebook_uri}"
                )
                raise KernelOpenError(message)
            if current is not None:
                self._close(current, notebook_uri)
            self._notify_changed()
            replacement.activate()
            return replacement

    def move(self, notebook_uri: str, new_notebook_uri: str) -> None:
        """Move a live session to a renamed notebook URI.

        Must not yield to the event loop between re-registering the session
        and ``session.move``: kernel notifications are forwarded on this loop
        (see ``receive`` in ``start``), so an ``await`` in that window would
        let them carry the old URI while the registry already answers for
        the new one.
        """
        with self._lock:
            self._invalidate_lifecycle(notebook_uri)
            session = self._sessions.pop(notebook_uri, None)
            if session is None:
                return
            self._invalidate_lifecycle(new_notebook_uri)
            replaced = self._sessions.pop(new_notebook_uri, None)
            self._sessions[new_notebook_uri] = session
        if replaced is not None:
            self._close(replaced, new_notebook_uri)
        session.move(new_notebook_uri, notify=False)
        try:
            session.sync(self._server.workspace)
        except KeyError:
            pass
        else:
            session.attach(notify=False)
        self._notify_changed()

    def attach(self, notebook_uri: str, workspace: Workspace) -> None:
        """Attach and synchronize an existing session."""
        session = self.get(notebook_uri)
        if session is None:
            return
        session.sync(workspace)
        session.attach()

    def sync(self, notebook_uri: str, workspace: Workspace) -> None:
        """Synchronize an existing session with its notebook document."""
        session = self.get(notebook_uri)
        if session is not None:
            session.sync(workspace)

    def detach(self, notebook_uri: str) -> None:
        """Detach an existing session without stopping its kernel."""
        session = self.get(notebook_uri)
        if session is not None:
            session.detach()

    def close(self, notebook_uri: str) -> None:
        """Close and forget a notebook's session."""
        with self._lock:
            self._invalidate_lifecycle(notebook_uri)
            session = self._sessions.pop(notebook_uri, None)
        if session is None:
            return

        self._close(session, notebook_uri)
        self._notify_changed()

    @staticmethod
    def _close(session: Session, notebook_uri: str) -> None:
        """Close a session without allowing cleanup failure to escape."""
        logger.info(f"Closing session for {notebook_uri}")
        try:
            session.close()
        except Exception:
            logger.exception(f"Error closing session for {notebook_uri}")

    def _kernel_failed(self, failed: Session, error: str) -> None:
        """Remove a session whose ready kernel transport terminated."""
        with self._lock:
            notebook_uri = next(
                (uri for uri, session in self._sessions.items() if session is failed),
                None,
            )
            if notebook_uri is None:
                return
            self._sessions.pop(notebook_uri)
        logger.error(f"Kernel failed for {notebook_uri}: {error}")
        self._close(failed, notebook_uri)
        self._notify_changed()

    def close_all(self) -> None:
        """Close all live sessions."""
        logger.info("Closing all sessions")
        with self._lock:
            for notebook_uri in self._lifecycle_locks:
                self._invalidate_lifecycle(notebook_uri)
            live = self._sessions
            self._sessions = {}
        for notebook_uri, session in live.items():
            self._close(session, notebook_uri)
        if live:
            self._notify_changed()
