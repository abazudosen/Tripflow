"""Behavioral tests for the travel workflow API."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from webapp import app, checkpoint_store, sessions


client = TestClient(app)


@pytest.fixture(autouse=True)
def isolate_test_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sessions.clear()
    checkpoint_root = tmp_path / "checkpoints"
    checkpoint_root.mkdir()
    monkeypatch.setattr(checkpoint_store, "root", checkpoint_root)


def create_session() -> str:
    response = client.post("/api/session")
    response.raise_for_status()
    return response.json()["session_id"]


def test_approval_gate_saves_checkpoint() -> None:
    session_id = create_session()

    response = client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "message": "Book a round trip from Lagos to Abuja next month with budget $700 for 2 travelers",
        },
    )
    payload = response.json()

    assert payload["status"] == "awaiting_approval"
    assert payload["checkpoint_ready"] is True
    assert "approval" in payload["message"].lower()
    assert payload["state"]["request"]["origin"] == "Lagos"
    assert payload["state"]["request"]["destination"] == "Abuja"
    assert payload["state"]["quotes"]["flight"] == 300
    assert payload["state"]["quotes"]["hotel"] == 300
    assert payload["state"]["quotes"]["insurance"] == 20
    assert payload["state"]["quotes"]["total"] == 620
    assert checkpoint_store.checkpoint_path(session_id).exists()


def test_denied_approval_stops_booking() -> None:
    session_id = create_session()
    client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "message": "Book a round trip from Lagos to Abuja next month with budget $700 for 2 travelers",
        },
    )

    response = client.post(
        "/api/approval",
        json={"session_id": session_id, "approve": False},
    )
    payload = response.json()

    assert payload["status"] == "blocked"
    assert payload["booking_reference"] is None


def test_approval_then_resume_completes_booking() -> None:
    session_id = create_session()
    client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "message": "Book a round trip from Lagos to Abuja next month with budget $700 for 2 travelers",
        },
    )

    approval_response = client.post(
        "/api/approval",
        json={"session_id": session_id, "approve": True},
    )
    assert approval_response.json()["status"] == "ready_to_resume"

    resume_response = client.post(
        "/api/resume",
        json={"session_id": session_id},
    )
    payload = resume_response.json()

    assert payload["status"] == "completed"
    assert payload["booking_reference"].startswith("TRIP-")
    assert any(event["step"] == "checkpoint" for event in payload["trace"])


def test_low_risk_request_completes_automatically() -> None:
    session_id = create_session()

    response = client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "message": "Book a round trip from Abuja to Lagos next month with budget 400 for 1 traveler",
        },
    )
    payload = response.json()

    assert payload["status"] == "completed"
    assert payload["booking_reference"].startswith("TRIP-")
    assert payload["state"]["quotes"]["total"] == 310


def test_quote_above_user_budget_stops_before_approval() -> None:
    session_id = create_session()

    response = client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "message": "Book a round trip from Abuja to Lagos next month with budget $500 for 2 travelers",
        },
    )
    payload = response.json()

    assert payload["status"] == "blocked"
    assert payload["booking_reference"] is None
    assert payload["checkpoint_ready"] is False
    assert payload["state"]["request"]["budget"] == 500
    assert payload["state"]["quotes"]["total"] == 620
    assert "exceeds your budget of $500" in payload["message"]
    assert "revise your budget" in payload["message"].lower()
    assert any(
        event["step"] == "monitor"
        and event["data"].get("budget") == 500
        for event in payload["trace"]
    )


def test_over_budget_request_can_be_revised_in_same_session() -> None:
    session_id = create_session()
    client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "message": "Book a round trip from Lagos to Abuja next month with budget $500 for 2 travelers",
        },
    )

    response = client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "message": "Revise budget to $700",
        },
    )
    payload = response.json()

    assert payload["status"] == "awaiting_approval"
    assert payload["state"]["request"]["budget"] == 700
    assert payload["state"]["quotes"]["total"] == 620


def test_budget_of_700_for_one_traveler_completes_automatically() -> None:
    session_id = create_session()

    response = client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "message": "Book a round trip from Abuja to Lagos next month with budget $700 for 1 traveler",
        },
    )
    payload = response.json()

    assert payload["status"] == "completed"
    assert payload["state"]["quotes"]["total"] == 310
    assert payload["booking_reference"] is not None


def test_budget_parser_does_not_read_approval_limit_as_trip_budget() -> None:
    session_id = create_session()

    response = client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "message": (
                "Book a round trip from Lagos to Abuja next month with budget $700 "
                "for 2 travelers and approval limit $610"
            ),
        },
    )
    payload = response.json()

    assert payload["state"]["request"]["budget"] == 700
    assert payload["state"]["policy"]["approval_limit"] == 610
    assert payload["status"] == "awaiting_approval"