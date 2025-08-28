"""ZeroMQ-based QueueManager implementation."""

from __future__ import annotations

import dataclasses
import json
import queue
import sys
import threading
import typing

import zmq

from marimo_lsp.zeromq.queue_proxy import PushQueue, start_queue_receiver_thread

if typing.TYPE_CHECKING:
    from marimo._runtime.requests import (
        CodeCompletionRequest,
        ControlRequest,
        SetUIElementValueRequest,
    )
    from marimo._server.types import QueueType


ADDR = "tcp://127.0.0.1"


@dataclasses.dataclass
class ConnectionInfo:
    """Marimo socket connection info."""

    control: int
    ui_element: int
    completion: int
    input: int
    win32_interrupt: int | None


def encode_connection_info(info: ConnectionInfo) -> str:
    """Encode ConnectionInfo as JSON."""
    return json.dumps(dataclasses.asdict(info))


def decode_connection_info(s: str) -> ConnectionInfo:
    """Decode JSON connection info."""
    data = json.loads(s)
    return ConnectionInfo(
        control=data["control"],
        ui_element=data["ui_element"],
        completion=data["completion"],
        input=data["input"],
        win32_interrupt=data["win32_interrupt"],
    )


@dataclasses.dataclass
class Connection:
    """Marimo socket connection."""

    context: zmq.Context

    control: zmq.Socket
    ui_element: zmq.Socket
    completion: zmq.Socket
    input: zmq.Socket
    win32_interrupt: zmq.Socket | None

    def close(self) -> None:
        """Close all sockets and context."""
        self.control.close()
        self.ui_element.close()
        self.completion.close()
        self.input.close()
        if self.win32_interrupt:
            self.win32_interrupt.close()
        self.context.term()


def create_host() -> tuple[Connection, ConnectionInfo]:
    """Create host-side sockets."""
    context = zmq.Context()

    conn = Connection(
        context=context,
        control=context.socket(zmq.PUSH),
        ui_element=context.socket(zmq.PUSH),
        completion=context.socket(zmq.PUSH),
        input=context.socket(zmq.PULL),
        win32_interrupt=context.socket(zmq.PUSH) if sys.platform == "win32" else None,
    )
    return (
        conn,
        ConnectionInfo(
            control=conn.control.bind_to_random_port(ADDR),
            ui_element=conn.ui_element.bind_to_random_port(ADDR),
            completion=conn.completion.bind_to_random_port(ADDR),
            input=conn.input.bind_to_random_port(ADDR),
            win32_interrupt=conn.win32_interrupt.bind_to_random_port(ADDR)
            if conn.win32_interrupt
            else None,
        ),
    )


def connect_kernel(info: ConnectionInfo) -> Connection:
    """Connect kernel-side sockets."""
    context = zmq.Context()

    conn = Connection(
        context=context,
        control=context.socket(zmq.PULL),
        ui_element=context.socket(zmq.PULL),
        completion=context.socket(zmq.PULL),
        input=context.socket(zmq.PUSH),
        win32_interrupt=context.socket(zmq.PULL) if info.win32_interrupt else None,
    )

    conn.control.connect(f"{ADDR}:{info.control}")
    conn.ui_element.connect(f"{ADDR}:{info.ui_element}")
    conn.completion.connect(f"{ADDR}:{info.completion}")
    conn.input.connect(f"{ADDR}:{info.input}")
    if conn.win32_interrupt:
        conn.win32_interrupt.connect(f"{ADDR}:{info.win32_interrupt}")

    return conn


@dataclasses.dataclass
class ZeroMqQueueManager:
    """Queue manager using ZeroMQ for inter-process communication.

    Always uses async ZeroMQ contexts. Receiver tasks must be started
    in an asyncio event loop.
    """

    conn: Connection

    control_queue: QueueType[ControlRequest]
    set_ui_element_queue: QueueType[SetUIElementValueRequest]
    completion_queue: QueueType[CodeCompletionRequest]
    input_queue: QueueType[str]
    win32_interrupt_queue: QueueType[bool] | None
    stream_queue: QueueType[bytes] | None

    # Receiver thread management
    _receiver_thread: threading.Thread | None = None
    _stop_event: threading.Event | None = None

    @classmethod
    def create_host(cls) -> tuple[ZeroMqQueueManager, ConnectionInfo]:
        """Create host-side queue manager with async sockets."""
        conn, info = create_host()

        input_queue = queue.Queue(maxsize=1)

        manager = cls(
            conn=conn,
            control_queue=PushQueue(conn.control),
            set_ui_element_queue=PushQueue(conn.ui_element),
            completion_queue=PushQueue(conn.completion),
            input_queue=input_queue,
            win32_interrupt_queue=PushQueue(conn.win32_interrupt)
            if conn.win32_interrupt
            else None,
            stream_queue=None,
        )

        return (manager, info)

    @classmethod
    def from_connection_info(cls, info: ConnectionInfo) -> ZeroMqQueueManager:
        """Create kernel-side queue manager from connection info."""
        conn = connect_kernel(info)

        control_queue = queue.Queue()
        ui_element_queue = queue.Queue()
        completion_queue = queue.Queue()
        win32_interrupt_queue = queue.Queue() if conn.win32_interrupt else None

        return cls(
            conn=conn,
            control_queue=control_queue,
            set_ui_element_queue=ui_element_queue,
            completion_queue=completion_queue,
            input_queue=PushQueue(conn.input, maxsize=1),
            win32_interrupt_queue=win32_interrupt_queue,
            stream_queue=None,
        )

    def start_receiver(self) -> None:
        """Start receiver thread."""
        assert self._receiver_thread is None, "Alread started"

        mapping: dict[zmq.Socket, QueueType] = {}

        if isinstance(self.control_queue, queue.Queue):
            mapping[self.conn.control] = self.control_queue

        if isinstance(self.set_ui_element_queue, queue.Queue):
            mapping[self.conn.ui_element] = self.set_ui_element_queue

        if isinstance(self.completion_queue, queue.Queue):
            mapping[self.conn.completion] = self.completion_queue

        if isinstance(self.input_queue, queue.Queue):
            mapping[self.conn.input] = self.input_queue

        if (
            self.conn.win32_interrupt
            and self.win32_interrupt_queue
            and isinstance(self.win32_interrupt_queue, queue.Queue)
        ):
            mapping[self.conn.win32_interrupt] = self.win32_interrupt_queue

        self._stop_event = threading.Event()
        self._receiver_thread = start_queue_receiver_thread(mapping, self._stop_event)

    def close_queues(self) -> None:
        """Close all queues and cleanup resources."""
        if self._stop_event:
            self._stop_event.set()
        if self._receiver_thread and self._receiver_thread.is_alive():
            self._receiver_thread.join(timeout=1)
        self.conn.close()
