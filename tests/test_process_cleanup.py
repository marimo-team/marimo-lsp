"""Tests for process cleanup on shutdown.

Verifies `PopenProcessLike` terminates subprocesses (including force-kill)
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import typing

import pytest

from marimo_lsp.kernel_manager import PopenProcessLike


def process_exists(pid: int) -> bool:
    """Check if a process with the given PID exists."""
    try:
        os.kill(pid, 0)
    except OSError:
        return False

    return True


@pytest.fixture
def long_running_process() -> typing.Generator[subprocess.Popen[bytes]]:
    """Create a long-running subprocess for testing."""
    process = subprocess.Popen(  # noqa: S603
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
    wrapper = PopenProcessLike(long_running_process)
    pid = wrapper.pid

    assert pid is not None
    assert wrapper.is_alive()
    assert process_exists(pid)

    wrapper.terminate()

    assert not wrapper.is_alive()
    assert not process_exists(pid)


def test_popen_terminate_already_dead() -> None:
    """Test that terminate() handles already-dead processes gracefully."""
    process = subprocess.Popen(  # noqa: S603
        [sys.executable, "-c", "pass"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    process.wait()

    wrapper = PopenProcessLike(process)
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
    wrapper = PopenProcessLike(stubborn_process)
    wrapper.TERMINATE_TIMEOUT = 0.5  # Shorter timeout for testing

    pid = wrapper.pid
    assert pid is not None
    assert wrapper.is_alive()

    wrapper.terminate()

    assert not wrapper.is_alive()
    assert not process_exists(pid)
