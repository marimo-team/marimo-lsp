# Copyright 2026 Marimo. All rights reserved.

"""Tests for native language server shutdown and kernel process cleanup."""

from __future__ import annotations

import subprocess
import sys
import time
import typing

import pytest

from marimo_lsp.kernels.manager import Process


def test_native_server_shutdown_does_not_write_to_closed_stdout() -> None:
    messages = (
        b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}',
        b'{"jsonrpc":"2.0","method":"initialized","params":{}}',
        b'{"jsonrpc":"2.0","id":2,"method":"shutdown","params":null}',
        b'{"jsonrpc":"2.0","method":"exit","params":null}',
    )
    result = subprocess.run(
        [sys.executable, "-c", "from marimo_lsp import main; main()"],
        input=b"".join(
            f"Content-Length: {len(body)}\r\n\r\n".encode() + body for body in messages
        ),
        capture_output=True,
        check=True,
        timeout=20,
    )
    assert b"Closing all sessions" in result.stdout
    assert result.stderr.count(b"write to closed file") == 0


@pytest.fixture
def long_running_process() -> typing.Generator[subprocess.Popen[bytes]]:
    """Create a long-running subprocess for testing."""
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    yield process

    if process.poll() is None:
        process.kill()
        process.wait()


@pytest.fixture
def stubborn_process() -> typing.Generator[subprocess.Popen[bytes]]:
    """Create a process that ignores SIGTERM for testing force-kill."""
    code = """
import signal
import time

def ignore_sigterm(signum, frame):
    pass

signal.signal(signal.SIGTERM, ignore_sigterm)
time.sleep(300)
"""
    process = subprocess.Popen(  # noqa: S603
        [sys.executable, "-c", code],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # Give time to set up the signal handler
    time.sleep(0.1)

    yield process

    if process.poll() is None:
        process.kill()
        process.wait()


def test_popen_terminate_graceful(
    long_running_process: subprocess.Popen[bytes],
) -> None:
    """Test that terminate() gracefully stops a process."""
    wrapper = Process(long_running_process)

    assert wrapper.pid is not None
    assert wrapper.is_alive()

    wrapper.terminate()

    assert not wrapper.is_alive()


def test_popen_terminate_already_dead() -> None:
    """Test that terminate() handles already-dead processes gracefully."""
    process = subprocess.Popen(
        [sys.executable, "-c", "pass"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    process.wait()

    wrapper = Process(process)
    wrapper.terminate()  # Should not raise

    assert not wrapper.is_alive()


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="SIGTERM handling differs on Windows",
)
def test_popen_terminate_force_kill(
    stubborn_process: subprocess.Popen[bytes],
) -> None:
    """Test that terminate() force-kills processes that ignore SIGTERM."""
    wrapper = Process(stubborn_process)
    wrapper.TERMINATE_TIMEOUT = 0.5  # Shorter timeout for testing

    assert wrapper.pid is not None
    assert wrapper.is_alive()

    wrapper.terminate()

    assert not wrapper.is_alive()
