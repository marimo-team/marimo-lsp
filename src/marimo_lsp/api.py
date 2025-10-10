"""Handlers for marimo.api commands."""

from __future__ import annotations

import dataclasses
from typing import TYPE_CHECKING, cast

import msgspec
from marimo._convert.converters import MarimoConvert
from marimo._runtime.packages.package_managers import create_package_manager
from marimo._runtime.requests import FunctionCallRequest, SetUserConfigRequest
from marimo._schemas.serialization import NotebookSerialization
from marimo._server.models.models import InstantiateRequest
from marimo._utils.parse_dataclass import parse_raw

from marimo_lsp.debug_adapter import handle_debug_adapter_request
from marimo_lsp.loggers import get_logger
from marimo_lsp.models import (
    DebugAdapterRequest,
    DependencyTreeRequest,
    DeserializeRequest,
    GetConfigurationRequest,
    InterruptRequest,
    ListPackagesRequest,
    NotebookCommand,
    RunRequest,
    SerializeRequest,
    SessionCommand,
    SetUIElementValueRequest,
    UpdateConfigurationRequest,
)
from marimo_lsp.package_manager import LspPackageManager

if TYPE_CHECKING:
    from marimo._config.config import PartialMarimoConfig
    from pygls.lsp.server import LanguageServer

    from marimo_lsp.kernel_manager import LspKernelManager
    from marimo_lsp.session_manager import LspSessionManager


__all__ = ["handle_api_command"]

logger = get_logger()


async def run(
    ls: LanguageServer, manager: LspSessionManager, args: SessionCommand[RunRequest]
):
    logger.info(f"run for {args.notebook_uri}")
    session = manager.get_session(args.notebook_uri)
    if (
        session is None
        or cast("LspKernelManager", session.kernel_manager).executable
        != args.executable
    ):
        session = manager.create_session(
            server=ls,
            executable=args.executable,
            notebook_uri=args.notebook_uri,
        )
        logger.info(f"Created and synced session {args.notebook_uri}")

    # We lazily instantiate the session until the first run command is sent
    # so we don't force connecting to a kernel unnecessarily
    is_instantiated = manager.is_instantiated(args.notebook_uri)
    if not is_instantiated:
        logger.info(f"Instantiating session {args.notebook_uri}")
        session.instantiate(
            InstantiateRequest(auto_run=False, object_ids=[], values=[]),
            http_request=None,
        )
        manager.set_instantiated(args.notebook_uri, instantiated=True)

    session.put_control_request(
        args.inner.as_execution_request(), from_consumer_id=None
    )
    logger.info(f"Execution request sent for {args.notebook_uri}")


async def set_ui_element_value(
    manager: LspSessionManager,
    args: NotebookCommand[SetUIElementValueRequest],
):
    logger.info(f"set_ui_element_value for {args.notebook_uri}")
    session = manager.get_session(args.notebook_uri)
    assert session, f"No session in workspace for {args.notebook_uri}"
    session.put_control_request(args.inner, from_consumer_id=None)


async def function_call_request(
    manager: LspSessionManager,
    args: NotebookCommand[FunctionCallRequest],
):
    logger.info(f"function_call_request for {args.notebook_uri}")
    session = manager.get_session(args.notebook_uri)
    assert session, f"No session in workspace for {args.notebook_uri}"
    session.put_control_request(args.inner, from_consumer_id=None)


async def interrupt(
    manager: LspSessionManager,
    args: NotebookCommand[InterruptRequest],
):
    logger.info(f"interrupt for {args.notebook_uri}")
    session = manager.get_session(args.notebook_uri)
    if session:
        session.try_interrupt()
        logger.info(f"Interrupt request sent for {args.notebook_uri}")
    else:
        logger.warning(f"No session found for {args.notebook_uri}")


async def get_package_list(
    manager: LspSessionManager,
    args: SessionCommand[ListPackagesRequest],
):
    logger.info(f"get_package_list for {args.notebook_uri}")
    session = manager.get_session(args.notebook_uri)
    if not session:
        logger.warning(f"No session found for {args.notebook_uri}")
        return {"packages": []}

    package_manager = LspPackageManager(
        delegate=create_package_manager("uv"),
        venv_location=args.executable,
    )
    if not package_manager.is_manager_installed():
        logger.warning(f"Package manager not installed for {args.notebook_uri}")
        return {"packages": []}

    packages = package_manager.list_packages()
    return msgspec.to_builtins({"packages": packages})


async def get_dependency_tree(
    manager: LspSessionManager,
    args: SessionCommand[DependencyTreeRequest],
):
    logger.info(f"get_dependency_tree for {args.notebook_uri}")
    session = manager.get_session(args.notebook_uri)
    if not session:
        logger.warning(f"No session found for {args.notebook_uri}")
        return {"tree": None}

    package_manager = LspPackageManager(
        delegate=create_package_manager("uv"),
        venv_location=args.executable,
    )

    is_sandbox = False
    if is_sandbox:
        filename = session.app_file_manager.filename
        tree = package_manager.dependency_tree(filename)
    else:
        tree = package_manager.dependency_tree()

    return msgspec.to_builtins({"tree": tree})


async def serialize(args: SerializeRequest):
    ir = parse_raw(args.notebook, cls=NotebookSerialization)
    return {"source": MarimoConvert.from_ir(ir).to_py()}


async def deserialize(args: DeserializeRequest):
    converter = MarimoConvert.from_py(args.source)
    return dataclasses.asdict(converter.to_ir())


async def dap(
    ls: LanguageServer,
    manager: LspSessionManager,
    args: NotebookCommand[DebugAdapterRequest],
):
    """Handle DAP messages forwarded from VS Code extension."""
    return handle_debug_adapter_request(
        ls=ls,
        manager=manager,
        notebook_uri=args.notebook_uri,
        session_id=args.inner.session_id,
        message=args.inner.message,
    )


async def get_configuration(
    manager: LspSessionManager,
    args: NotebookCommand[GetConfigurationRequest],
):
    """Get the current marimo configuration."""
    session = manager.get_session(args.notebook_uri)
    if not session:
        logger.warning(f"No session found for {args.notebook_uri}")
        return {"config": {}}

    # Get the configuration from the session's config manager
    config = session.config_manager.get_config(hide_secrets=True)
    return msgspec.to_builtins({"config": config})


async def update_configuration(
    manager: LspSessionManager,
    args: NotebookCommand[UpdateConfigurationRequest],
):
    """Update the marimo user configuration."""
    session = manager.get_session(args.notebook_uri)
    if not session:
        logger.warning(f"No session found for {args.notebook_uri}")
        return {"success": False, "error": "No session found"}

    try:
        updated_config = session.config_manager.save_config(
            cast("PartialMarimoConfig", args.inner.config)
        )

        # Update the kernel's view of the config
        session.put_control_request(
            SetUserConfigRequest(updated_config),
            from_consumer_id=None,
        )

        return msgspec.to_builtins({"success": True, "config": updated_config})
    except Exception as e:
        logger.exception(f"Error updating configuration for {args.notebook_uri}")
        return {"success": False, "error": str(e)}


async def handle_api_command(  # noqa: C901, PLR0911
    ls: LanguageServer, manager: LspSessionManager, method: str, params: dict
) -> object:
    """Unified API endpoint for all marimo internal methods."""
    if method == "run":
        return await run(
            ls, manager, msgspec.convert(params, type=SessionCommand[RunRequest])
        )

    if method == "interrupt":
        return await interrupt(
            manager, msgspec.convert(params, type=NotebookCommand[InterruptRequest])
        )

    if method == "set_ui_element_value":
        return await set_ui_element_value(
            manager,
            msgspec.convert(params, type=NotebookCommand[SetUIElementValueRequest]),
        )

    if method == "function_call_request":
        return await function_call_request(
            manager,
            msgspec.convert(params, type=NotebookCommand[FunctionCallRequest]),
        )

    if method == "dap":
        return await dap(
            ls,
            manager,
            msgspec.convert(params, type=NotebookCommand[DebugAdapterRequest]),
        )

    if method == "serialize":
        return await serialize(msgspec.convert(params, type=SerializeRequest))

    if method == "deserialize":
        return await deserialize(msgspec.convert(params, type=DeserializeRequest))

    if method == "get_package_list":
        return await get_package_list(
            manager,
            msgspec.convert(params, type=SessionCommand[ListPackagesRequest]),
        )

    if method == "get_dependency_tree":
        return await get_dependency_tree(
            manager,
            msgspec.convert(params, type=SessionCommand[DependencyTreeRequest]),
        )

    if method == "get_configuration":
        return await get_configuration(
            manager,
            msgspec.convert(params, type=NotebookCommand[GetConfigurationRequest]),
        )

    if method == "update_configuration":
        return await update_configuration(
            manager,
            msgspec.convert(params, type=NotebookCommand[UpdateConfigurationRequest]),
        )

    logger.warning(f"Unknown API method: {method}")
    raise ValueError(method)
