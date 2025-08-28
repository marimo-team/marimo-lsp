"""ZeroMQ-based TypedConnection implementation."""

from __future__ import annotations

import pickle
import threading
from typing import TypeVar

import zmq

T = TypeVar("T")


class ZMQTypedConnection[T]:
    """TypedConnection implementation using ZeroMQ PUB/SUB sockets."""

    def __init__(self, socket: zmq.Socket, *, is_sender: bool = True) -> None:
        """Initialize ZMQ typed connection.

        Parameters
        ----------
        socket
            ZeroMQ socket (PUB for sender, SUB for receiver)
        is_sender
            Whether this is the sender side (PUB) or receiver side (SUB)

        """
        self.socket = socket
        self.is_sender = is_sender
        self._closed = False
        self._recv_buffer: list[T] = []
        self._recv_lock = threading.Lock()

        if not is_sender:
            # Subscribe to all messages
            socket.setsockopt(zmq.SUBSCRIBE, b"")
            # Start receiver thread
            self._stop_event = threading.Event()
            self._receiver_thread = threading.Thread(
                target=self._receive_loop, daemon=True
            )
            self._receiver_thread.start()

    def _receive_loop(self) -> None:
        """Background thread to receive messages."""
        poller = zmq.Poller()
        poller.register(self.socket, zmq.POLLIN)

        while not self._stop_event.is_set():
            try:
                socks = dict(poller.poll(100))  # 100ms timeout
                if self.socket in socks and socks[self.socket] == zmq.POLLIN:
                    msg = self.socket.recv()
                    obj = pickle.loads(msg)
                    with self._recv_lock:
                        self._recv_buffer.append(obj)
            except zmq.ZMQError:
                break
            except Exception:
                continue

    @classmethod
    def of(cls, socket: zmq.Socket, is_sender: bool = True) -> ZMQTypedConnection[T]:
        """Create a typed connection from a ZeroMQ socket."""
        return cls(socket, is_sender)

    def send(self, obj: T) -> None:
        """Send an object through the connection."""
        if not self.is_sender:
            msg = "Cannot send on a receiver connection"
            raise RuntimeError(msg)
        if self._closed:
            msg = "Connection is closed"
            raise RuntimeError(msg)

        msg = pickle.dumps(obj)
        self.socket.send(msg)

    def recv(self) -> T:
        """Receive an object from the connection."""
        if self.is_sender:
            msg = "Cannot receive on a sender connection"
            raise RuntimeError(msg)
        if self._closed:
            msg = "Connection is closed"
            raise RuntimeError(msg)

        # Wait for message in buffer
        while True:
            with self._recv_lock:
                if self._recv_buffer:
                    return self._recv_buffer.pop(0)
            # Small sleep to avoid busy waiting
            threading.Event().wait(0.01)

    def poll(self, timeout: float = 0) -> bool:
        """Check if data is available to receive."""
        if self.is_sender:
            return False

        with self._recv_lock:
            if self._recv_buffer:
                return True

        # Check socket directly
        try:
            return self.socket.poll(timeout=int(timeout * 1000), flags=zmq.POLLIN) > 0
        except zmq.ZMQError:
            return False

    def fileno(self) -> int:
        """Get the file descriptor (not applicable for ZMQ)."""
        # ZMQ sockets don't have a single file descriptor
        # Return -1 to indicate not supported
        return -1

    @property
    def closed(self) -> bool:
        """Check if the connection is closed."""
        return self._closed

    def close(self) -> None:
        """Close the connection."""
        if not self._closed:
            self._closed = True
            if not self.is_sender and hasattr(self, "_stop_event"):
                self._stop_event.set()
                if hasattr(self, "_receiver_thread"):
                    self._receiver_thread.join(timeout=1.0)
