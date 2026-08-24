# Copyright 2026 Marimo. All rights reserved.

"""Live kernel sessions owned by the language server."""

from __future__ import annotations

import asyncio
import json
import threading
import time
import typing
from dataclasses import dataclass
from typing import TYPE_CHECKING, cast
from uuid import uuid4

import msgspec
from marimo._config.manager import get_default_config_manager
from marimo._messaging.msgspec_encoder import asdict
from marimo._messaging.notification import CellNotification
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
from marimo._types.ids import CellId_t, SessionId

from marimo_lsp.app_file_manager import LspAppFileManager, find_notebook_document
from marimo_lsp.kernels import KernelOpenError, normalize_marimo_version
from marimo_lsp.loggers import get_logger
from marimo_lsp.models import (
    KernelNotification,
    ListSessionsResponse,
    SavedSessionLocation,
    SessionInfo,
)
from marimo_lsp.saved_session_store import LocalSavedSessionFiles
from marimo_lsp.saved_session_writer import SavedSessionWriter
from marimo_lsp.saved_sessions import (
    decode_saved_session_view,
    restore_saved_session_view,
    serialize_saved_session_view,
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
    from marimo._schemas.session import NotebookSessionV1
    from marimo._session.requests import InstantiateNotebookRequest
    from marimo._types.ids import ConsumerId
    from pygls.lsp.server import LanguageServer
    from pygls.workspace import Workspace

    from marimo_lsp.kernels import Kernel, Kernels
    from marimo_lsp.saved_session_store import SavedSessionFiles


logger = get_logger()

_MAX_CANCELLED_SCRATCHPAD_RUNS = 1024


@dataclass(frozen=True)
class _SessionViewSource:
    session: Session
    reuse_live_view: bool


def _session_view_source(
    previous: Session | None,
    saved_session_source: Session | None,
) -> _SessionViewSource | None:
    if previous is not None:
        return _SessionViewSource(previous, reuse_live_view=True)
    if saved_session_source is not None:
        return _SessionViewSource(saved_session_source, reuse_live_view=False)
    return None


def _raise_kernel_failure(_session: Session, error: str) -> None:
    """Turn a terminal failure before publication into a launch failure."""
    raise KernelOpenError(error)


def _notification_name(message: KernelMessage) -> str:
    """Best-effort op name of a kernel message, for logging only."""
    try:
        return deserialize_kernel_notification_name(message)
    except Exception:  # noqa: BLE001
        return "<undecodable>"


async def _locate_saved_session(
    kernel: Kernel,
    notebook_path: str | None,
) -> str | None:
    """Resolve an optional cache path without making kernel startup fail."""
    if notebook_path is None:
        return None
    try:
        return await kernel.locate_saved_session(notebook_path)
    except Exception:
        logger.exception("Unable to locate saved session")
        return None


async def _read_saved_session(
    files: SavedSessionFiles,
    target: str | None,
    app_file_manager: LspAppFileManager,
    marimo_version: str | None,
) -> SessionView | None:
    """Read one compatible view before its authoritative Session starts."""
    if target is None or marimo_version is None:
        return None
    try:
        contents = await files.read(target)
        if contents is None:
            return None
        cell_manager = app_file_manager.app.cell_manager
        return await asyncio.to_thread(
            decode_saved_session_view,
            contents,
            codes=tuple(cell_manager.codes()),
            cell_ids=tuple(cell_manager.cell_ids()),
            marimo_version=marimo_version,
            header=app_file_manager.header,
        )
    except Exception:
        logger.exception("Unable to read saved session")
        return None


async def _initial_session_view(
    source: _SessionViewSource | None,
    kernel: Kernel,
    files: SavedSessionFiles,
    target: str | None,
    app_file_manager: LspAppFileManager,
) -> tuple[SessionView | None, bool]:
    """Reuse a compatible live view, otherwise restore the selected cache."""
    source_session = source.session if source is not None else None
    source_version = normalize_marimo_version(
        source_session.marimo_version if source_session is not None else None
    )
    kernel_version = normalize_marimo_version(kernel.marimo_version)
    reuse_previous = (
        source is not None
        and source.reuse_live_view
        and not source.session.requires_restart
        and source_version is not None
        and kernel_version is not None
        and source_version == kernel_version
    )
    if reuse_previous:
        return source.session.session_view, True

    if (
        source_session is not None
        and source_version is not None
        and source_version == kernel_version
    ):
        previous_snapshot = serialize_saved_session_view(
            source_session.session_view,
            cell_ids=source_session.app_file_manager.app.cell_manager.cell_ids(),
            marimo_version=source_version,
            header=source_session.app_file_manager.header,
        )
        if previous_snapshot is not None:
            cell_manager = app_file_manager.app.cell_manager
            current_codes = tuple(cell_manager.codes())
            current_cell_ids = tuple(cell_manager.cell_ids())
            restored = restore_saved_session_view(
                previous_snapshot,
                codes=current_codes,
                cell_ids=current_cell_ids,
                marimo_version=kernel_version,
                header=app_file_manager.header,
            )
            if restored is not None:
                restored.last_executed_code.update(
                    zip(current_cell_ids, current_codes, strict=True)
                )
                return restored, True

    return (
        await _read_saved_session(
            files,
            target,
            app_file_manager,
            kernel_version,
        ),
        False,
    )


def _session_output_notifications(
    view: SessionView,
    code_lookup: typing.Mapping[CellId_t, str],
    *,
    stale: bool = False,
) -> list[CellNotification]:
    notifications: list[CellNotification] = []
    for notification in view.notifications:
        if not isinstance(notification, CellNotification):
            continue
        code = code_lookup.get(notification.cell_id)
        has_display = notification.output is not None or bool(notification.console)
        is_in_flight = notification.status in ("queued", "running")
        if code is None or (not has_display and not is_in_flight):
            continue
        current_notification = notification
        if stale or view.last_executed_code.get(notification.cell_id) != code:
            current_notification = msgspec.structs.replace(
                notification,
                stale_inputs=True,
            )
        notifications.append(current_notification)
    return notifications


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
        started_at: float | None = None,
        saved_session_files: SavedSessionFiles | None = None,
        saved_session_target: str | None = None,
        saved_session_pending: bool = False,
    ) -> None:
        self.session_id = session_id
        self._notebook_uri = notebook_uri
        self._app_file_manager = app_file_manager
        self._config_manager = config_manager
        # Used by exporters and scratchpad snapshots.
        self.session_view = session_view if session_view is not None else SessionView()
        # A new or disk-restored view must not overwrite the sidecar before a
        # kernel request supplies current code hashes. A reused live view is
        # retried because its previous writer may have been interrupted.
        if not saved_session_pending:
            self.session_view.mark_auto_export_session()

        self._operation_sink = _OperationSink(
            server,
            notebook_uri,
            session_id,
            activated=False,
        )
        self._activated = False
        self._closed = False
        self._requires_restart = False
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
        self._saved_session_files = (
            saved_session_files
            if saved_session_files is not None
            else LocalSavedSessionFiles()
        )
        self._saved_session_pending = saved_session_pending
        self._saved_session_writer = self._make_saved_session_writer(
            saved_session_target
        )
        self._saved_session_location: asyncio.Task[None] | None = None
        logger.info(f"Started session {session_id}")

    def _make_saved_session_writer(
        self,
        target: str | None,
    ) -> SavedSessionWriter | None:
        if self.marimo_version is None or target is None:
            return None
        writer = SavedSessionWriter(
            view=self.session_view,
            app_file_manager=self._app_file_manager,
            marimo_version=self.marimo_version,
            target=target,
            files=self._saved_session_files,
            pending=self._saved_session_pending,
        )
        self._saved_session_pending = False
        return writer

    def _stop_saved_session_writer(self) -> None:
        writer = self._saved_session_writer
        self._saved_session_writer = None
        if writer is not None:
            self._saved_session_pending |= writer.stop()

    @property
    def executable(self) -> str:
        """Return the Python executable used by this session."""
        return self._kernel.executable

    @property
    def working_directory(self) -> str:
        """Return the configured kernel working directory."""
        return self._kernel.working_directory

    @property
    def marimo_version(self) -> str | None:
        """Return the exact version reported by the launched kernel."""
        return normalize_marimo_version(self._kernel.marimo_version)

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

    @property
    def requires_restart(self) -> bool:
        """Return whether detached source changes invalidated the live graph."""
        return self._requires_restart

    def get_config(self, *, hide_secrets: bool = True) -> MarimoConfig:
        """Return this session's configured marimo settings."""
        return self._config_manager.get_config(hide_secrets=hide_secrets)

    def save_config(self, config: PartialMarimoConfig) -> MarimoConfig:
        """Persist configuration and apply its effective runtime value."""
        updated = self._config_manager.save_config(config)
        self.update_runtime_config(updated)
        return updated

    def sync(self, workspace: Workspace) -> bool:
        """Synchronize the live app with the current notebook document."""
        if self._requires_restart:
            return False
        previous_document = self._app_file_manager.document_snapshot()
        if not self.attached:
            current_source = self._app_file_manager.workspace_source_snapshot(workspace)
            if self._app_file_manager.source_snapshot() != current_source:
                self._requires_restart = True
                return True
        previous_configs = {
            cell_id: config.asdict()
            for cell_id, config in self._app_file_manager.app.cell_manager.config_map().items()
        }
        self._app_file_manager.sync(workspace)
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
        return previous_document != self._app_file_manager.document_snapshot()

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
        self._stop_saved_session_writer()
        if self._saved_session_location is not None:
            self._saved_session_location.cancel()
            self._saved_session_location = None
        with self._state_lock:
            self._notebook_uri = notebook_uri
            self._operation_sink.move(notebook_uri)
            self._app_file_manager.move(notebook_uri)
        notebook_path = self._app_file_manager.path
        if notebook_path is not None:
            self._saved_session_location = asyncio.create_task(
                self._relocate_saved_session(notebook_path)
            )
        if notify:
            self._on_change()

    def instantiate(
        self,
        request: InstantiateNotebookRequest,
        *,
        http_request: HTTPRequest | None,
    ) -> None:
        """Instantiate the notebook."""
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

    def activate(self) -> None:
        """Release operations after this session becomes authoritative."""
        self._activated = True
        self._operation_sink.activate()
        if self._saved_session_writer is not None:
            self._saved_session_writer.start()

    async def _relocate_saved_session(self, notebook_path: str) -> None:
        """Rebind persistence after a notebook rename."""
        try:
            target = await self._kernel.locate_saved_session(notebook_path)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unable to locate saved session after notebook move")
            return
        if self._closed or self._app_file_manager.path != notebook_path:
            return
        self._saved_session_writer = self._make_saved_session_writer(target)
        if self._activated and self._saved_session_writer is not None:
            self._saved_session_writer.start()

    def close(self) -> None:
        """Close the session and its owned kernel resources."""
        if self._closed:
            return
        self._closed = True
        try:
            if self._saved_session_location is not None:
                try:
                    self._saved_session_location.cancel()
                except RuntimeError:
                    logger.exception("Unable to cancel saved-session relocation")
                self._saved_session_location = None
            try:
                self._stop_saved_session_writer()
            except RuntimeError:
                logger.exception("Unable to stop saved-session writer")
            try:
                self._idle.set()
            except RuntimeError:
                logger.exception("Unable to release idle-session waiters")
            self._on_change = lambda: None
            logger.info(f"Closing session {self.session_id}")
        finally:
            try:
                self._kernel.close()
            finally:
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
        self._saved_session_files = saved_session_files or LocalSavedSessionFiles()
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

    async def read_session_outputs(
        self,
        notebook_uri: str,
        location: SavedSessionLocation | None,
    ) -> list[CellNotification]:
        """Read the authoritative live or compatible saved display state."""
        lock = self._lifecycle_lock(notebook_uri)
        live_snapshot: NotebookSessionV1 | None = None
        async with lock:
            session = self.get(notebook_uri)
            if session is not None and not session.requires_restart:
                return _session_output_notifications(
                    session.session_view,
                    session.app.cell_manager.code_lookup(),
                )

            try:
                notebook = find_notebook_document(
                    self._server.workspace,
                    notebook_uri,
                )
                app_file_manager = LspAppFileManager(
                    server=self._server,
                    notebook_uri=notebook_uri,
                )
                notebook_version = notebook.version
            except KeyError:
                return []

            if session is not None:
                live_snapshot = serialize_saved_session_view(
                    session.session_view,
                    cell_ids=session.app_file_manager.app.cell_manager.cell_ids(),
                    marimo_version=session.marimo_version,
                    header=session.app_file_manager.header,
                )
            source_session = session

        cell_manager = app_file_manager.app.cell_manager
        view = (
            await asyncio.to_thread(
                restore_saved_session_view,
                live_snapshot,
                codes=tuple(cell_manager.codes()),
                cell_ids=tuple(cell_manager.cell_ids()),
                marimo_version=(
                    source_session.marimo_version
                    if source_session is not None
                    else None
                ),
                header=app_file_manager.header,
            )
            if live_snapshot is not None
            else None
        )

        if view is None and location is not None:
            view = await _read_saved_session(
                self._saved_session_files,
                location.cache_path,
                app_file_manager,
                location.marimo_version,
            )

        async with lock:
            session = self.get(notebook_uri)
            if session is not None and not session.requires_restart:
                return _session_output_notifications(
                    session.session_view,
                    session.app.cell_manager.code_lookup(),
                )
            if session is not source_session:
                return []
            try:
                current = find_notebook_document(
                    self._server.workspace,
                    notebook_uri,
                )
            except KeyError:
                current = None
            if (
                view is None
                or current is not notebook
                or current.version != notebook_version
            ):
                return []

            return _session_output_notifications(
                view,
                app_file_manager.app.cell_manager.code_lookup(),
                stale=True,
            )

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
            if (
                current is not None
                and current.executable == executable
                and not current.attached
                and not current.requires_restart
            ):
                current.sync(self._server.workspace)
            if (
                current is not None
                and current.executable == executable
                and not current.requires_restart
            ):
                current.attach()
                return current

            version = self._lifecycle_version(notebook_uri)
            if current is not None and current.executable == executable:
                replacement = await self._create(
                    notebook_uri,
                    executable,
                    working_directory,
                    previous=current,
                )
            else:
                replacement = await self._create(
                    notebook_uri,
                    executable,
                    working_directory,
                    saved_session_source=current,
                )
            with self._lock:
                try:
                    source_changed = (
                        replacement.app_file_manager.document_snapshot()
                        != replacement.app_file_manager.workspace_document_snapshot(
                            self._server.workspace
                        )
                    )
                # Any invalid workspace snapshot makes the launched kernel
                # unsafe to publish, regardless of the parser's exception.
                except Exception:  # noqa: BLE001
                    source_changed = True
                if version != self._lifecycle_version(notebook_uri) or source_changed:
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

    async def _create(
        self,
        notebook_uri: str,
        executable: str,
        working_directory: str,
        *,
        previous: Session | None = None,
        saved_session_source: Session | None = None,
    ) -> Session:
        app_file_manager = (
            previous.app_file_manager
            if previous is not None and not previous.requires_restart
            else None
        )
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
            saved_session_target = await _locate_saved_session(
                kernel,
                app_file_manager.path,
            )
            session_view, saved_session_pending = await _initial_session_view(
                _session_view_source(previous, saved_session_source),
                kernel,
                self._saved_session_files,
                saved_session_target,
                app_file_manager,
            )
            session = Session(
                session_id=session_id,
                notebook_uri=notebook_uri,
                server=self._server,
                kernel=kernel,
                app_file_manager=app_file_manager,
                config_manager=config_manager,
                session_view=session_view,
                started_at=previous.started_at if previous else None,
                saved_session_files=self._saved_session_files,
                saved_session_target=saved_session_target,
                saved_session_pending=saved_session_pending,
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
                    notebook_uri,
                    executable,
                    working_directory,
                )
            else:
                replacement = await self._create(
                    notebook_uri,
                    current.executable,
                    current.working_directory,
                    previous=current,
                )
                if not current.attached and not current.requires_restart:
                    replacement.detach(notify=False)

            with self._lock:
                try:
                    source_changed = (
                        replacement.app_file_manager.document_snapshot()
                        != replacement.app_file_manager.workspace_document_snapshot(
                            self._server.workspace
                        )
                    )
                # Any invalid workspace snapshot makes the launched kernel
                # unsafe to publish, regardless of the parser's exception.
                except Exception:  # noqa: BLE001
                    source_changed = True
                if version != self._lifecycle_version(notebook_uri) or source_changed:
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
            if not session.requires_restart:
                session.attach(notify=False)
        self._notify_changed()

    def attach(self, notebook_uri: str, workspace: Workspace) -> None:
        """Attach and synchronize an existing session."""
        with self._lock:
            self._invalidate_lifecycle(notebook_uri)
            session = self._sessions.get(notebook_uri)
        if session is None:
            return
        session.sync(workspace)
        if not session.requires_restart:
            session.attach()

    def sync(self, notebook_uri: str, workspace: Workspace) -> None:
        """Synchronize an existing session with its notebook document."""
        with self._lock:
            session = self._sessions.get(notebook_uri)
        if session is None:
            return
        previous_document = session.app_file_manager.document_snapshot()
        previous_requires_restart = session.requires_restart
        changed = False
        try:
            changed = session.sync(workspace)
        finally:
            try:
                changed = (
                    changed
                    or previous_requires_restart != session.requires_restart
                    or previous_document != session.app_file_manager.document_snapshot()
                )
            # A failed source comparison must still invalidate an in-flight
            # launch; publishing the older graph would be worse than retrying.
            except Exception:  # noqa: BLE001
                changed = True
            if changed:
                with self._lock:
                    if self._sessions.get(notebook_uri) is session:
                        self._invalidate_lifecycle(notebook_uri)

    def detach(self, notebook_uri: str) -> None:
        """Detach an existing session without stopping its kernel."""
        with self._lock:
            self._invalidate_lifecycle(notebook_uri)
            session = self._sessions.get(notebook_uri)
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
