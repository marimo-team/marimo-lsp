# Copyright 2026 Marimo. All rights reserved.

"""Characterize marimo's saved-session wire format and cache matching."""

from __future__ import annotations

import json
import sys
from typing import TYPE_CHECKING

import pytest
from marimo import __version__
from marimo._ast.cell import CellConfig
from marimo._messaging.cell_output import CellChannel, CellOutput
from marimo._messaging.notebook.document import NotebookCell, NotebookDocument
from marimo._messaging.notification import CellNotification
from marimo._session.state.serialize import (
    SessionCacheKey,
    SessionCacheManager,
    get_session_cache_file,
    serialize_session_view,
)
from marimo._session.state.session_view import SessionView
from marimo._types.ids import CellId_t

if TYPE_CHECKING:
    from pathlib import Path

    from marimo._schemas.session import NotebookSessionV1


SAVED_SLIDER_ID = CellId_t("saved-slider")
SAVED_WIDGET_ID = CellId_t("saved-widget")
CURRENT_SLIDER_ID = CellId_t("current-slider")
CURRENT_WIDGET_ID = CellId_t("current-widget")
SLIDER_CODE = "slider = mo.ui.slider(1, 10)\nslider"
WIDGET_CODE = "widget"
SCRIPT_METADATA_HASH = "project-hash"
SLIDER_HTML = (
    "<marimo-ui-element object-id='slider'>"
    "<marimo-slider data-initial-value='4'></marimo-slider>"
    "</marimo-ui-element>"
)


def _document(*cell_ids: CellId_t) -> NotebookDocument:
    return NotebookDocument(
        [
            NotebookCell(id=cell_id, code="", name="__", config=CellConfig())
            for cell_id in cell_ids
        ]
    )


def _saved_session() -> NotebookSessionV1:
    view = SessionView()
    view.cell_notifications[SAVED_SLIDER_ID] = CellNotification(
        cell_id=SAVED_SLIDER_ID,
        status="idle",
        output=CellOutput(
            channel=CellChannel.OUTPUT,
            mimetype="text/html",
            data=SLIDER_HTML,
        ),
        console=[
            CellOutput(
                channel=CellChannel.STDOUT,
                mimetype="text/plain",
                data="ready\n",
            )
        ],
        timestamp=12.5,
    )
    view.cell_notifications[SAVED_WIDGET_ID] = CellNotification(
        cell_id=SAVED_WIDGET_ID,
        status="idle",
        output=CellOutput(
            channel=CellChannel.OUTPUT,
            mimetype="text/html",
            data='<img src="./@file/4-image.png">',
        ),
        console=[],
        timestamp=13,
    )
    view.last_executed_code[SAVED_SLIDER_ID] = SLIDER_CODE
    view.last_executed_code[SAVED_WIDGET_ID] = WIDGET_CODE

    return serialize_session_view(
        view,
        cell_ids=[SAVED_SLIDER_ID, SAVED_WIDGET_ID],
        drop_virtual_file_outputs=True,
        script_metadata_hash=SCRIPT_METADATA_HASH,
    )


def test_default_session_cache_path_is_beside_the_notebook(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "pycache_prefix", None)
    notebook = tmp_path / "notebook.py"

    assert get_session_cache_file(notebook) == (
        tmp_path / "__marimo__" / "session" / "notebook.py.json"
    )


def test_session_cache_path_follows_pycache_prefix(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prefix = tmp_path / "cache"
    monkeypatch.setattr(sys, "pycache_prefix", str(prefix))
    notebook = tmp_path / "project" / "notebook.py"
    relative_parent = notebook.parent.relative_to(notebook.anchor)

    assert get_session_cache_file(notebook) == (
        prefix / relative_parent / "__marimo__" / "session" / "notebook.py.json"
    )


def test_upstream_serializer_uses_v1_wire_format() -> None:
    assert _saved_session() == {
        "version": "1",
        "metadata": {
            "marimo_version": __version__,
            "script_metadata_hash": SCRIPT_METADATA_HASH,
        },
        "cells": [
            {
                "id": "saved-slider",
                "code_hash": "3b34862224f98ab57b70f606ad4f9a20",
                "outputs": [
                    {
                        "type": "data",
                        "data": {
                            "text/html": SLIDER_HTML,
                        },
                    }
                ],
                "console": [
                    {
                        "type": "stream",
                        "name": "stdout",
                        "text": "ready\n",
                        "mimetype": "text/plain",
                    }
                ],
            },
            {
                "id": "saved-widget",
                "code_hash": "9d2b1ad5bbc16c44d49116dc213c53f2",
                "outputs": [],
                "console": [],
            },
        ],
    }


def test_upstream_deserializer_restores_output_by_code_hash(tmp_path: Path) -> None:
    notebook = tmp_path / "notebook.py"
    cache_file = get_session_cache_file(notebook)
    cache_file.parent.mkdir(parents=True)
    cache_file.write_text(json.dumps(_saved_session()), encoding="utf-8")
    manager = SessionCacheManager(
        SessionView(),
        _document(CURRENT_SLIDER_ID, CURRENT_WIDGET_ID),
        notebook,
        interval=1,
    )

    restored = manager.read_session_view(
        SessionCacheKey(
            codes=(SLIDER_CODE, WIDGET_CODE),
            marimo_version=__version__,
            cell_ids=(CURRENT_SLIDER_ID, CURRENT_WIDGET_ID),
            script_metadata_hash=SCRIPT_METADATA_HASH,
        )
    )

    assert set(restored.cell_notifications) == {
        CURRENT_SLIDER_ID,
        CURRENT_WIDGET_ID,
    }
    slider = restored.cell_notifications[CURRENT_SLIDER_ID]
    assert slider.status == "idle"
    assert slider.timestamp == 0
    assert slider.output is not None
    assert slider.output.channel == CellChannel.OUTPUT
    assert slider.output.mimetype == "text/html"
    assert slider.output.data == SLIDER_HTML
    assert isinstance(slider.console, list)
    [console] = slider.console
    assert isinstance(console, CellOutput)
    assert console.channel == CellChannel.STDOUT
    assert console.mimetype == "text/plain"
    assert console.data == "ready\n"
    assert restored.cell_notifications[CURRENT_WIDGET_ID].output is None
    assert restored.last_executed_code == {}


@pytest.mark.parametrize(
    ("codes", "marimo_version", "script_metadata_hash"),
    [
        pytest.param(
            ("slider", WIDGET_CODE),
            __version__,
            SCRIPT_METADATA_HASH,
            id="code-changed",
        ),
        pytest.param(
            (WIDGET_CODE, SLIDER_CODE),
            __version__,
            SCRIPT_METADATA_HASH,
            id="cell-order",
        ),
        pytest.param(
            (SLIDER_CODE,),
            __version__,
            SCRIPT_METADATA_HASH,
            id="cell-count",
        ),
        pytest.param(
            (SLIDER_CODE, WIDGET_CODE),
            "0.0.0",
            SCRIPT_METADATA_HASH,
            id="marimo-version",
        ),
        pytest.param(
            (SLIDER_CODE, WIDGET_CODE),
            __version__,
            "different-project",
            id="script-metadata",
        ),
    ],
)
def test_upstream_cache_matching_rejects_incompatible_keys(
    codes: tuple[str, ...],
    marimo_version: str,
    script_metadata_hash: str,
) -> None:
    manager = SessionCacheManager(
        SessionView(),
        _document(SAVED_SLIDER_ID, SAVED_WIDGET_ID),
        None,
        interval=1,
    )

    assert not manager.is_cache_hit(
        _saved_session(),
        SessionCacheKey(
            codes=codes,
            marimo_version=marimo_version,
            cell_ids=(SAVED_SLIDER_ID, SAVED_WIDGET_ID),
            script_metadata_hash=script_metadata_hash,
        ),
    )


def test_upstream_reader_ignores_invalid_json(tmp_path: Path) -> None:
    notebook = tmp_path / "notebook.py"
    cache_file = get_session_cache_file(notebook)
    cache_file.parent.mkdir(parents=True)
    cache_file.write_text("not json", encoding="utf-8")
    original = SessionView()
    manager = SessionCacheManager(
        original,
        _document(CURRENT_SLIDER_ID, CURRENT_WIDGET_ID),
        notebook,
        interval=1,
    )

    restored = manager.read_session_view(
        SessionCacheKey(
            codes=(SLIDER_CODE, WIDGET_CODE),
            marimo_version=__version__,
            cell_ids=(CURRENT_SLIDER_ID, CURRENT_WIDGET_ID),
            script_metadata_hash=SCRIPT_METADATA_HASH,
        )
    )

    assert restored is original
