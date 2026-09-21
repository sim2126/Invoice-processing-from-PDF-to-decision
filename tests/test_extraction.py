"""Provider boundary checks with explicit, isolated doubles; no live model calls."""

from types import SimpleNamespace

import pytest
from ap import extraction
from ap.schemas import Extraction
from pydantic import ValidationError


@pytest.mark.parametrize("state", ["incomplete", "completed"])
def test_refusal_or_incomplete_response_never_invents_extraction(monkeypatch, state):
    monkeypatch.setattr(
        extraction, "settings", SimpleNamespace(api_key="test-only", model="test-model")
    )
    response = SimpleNamespace(status=state, output_parsed=None)
    client = SimpleNamespace(responses=SimpleNamespace(parse=lambda **kw: response))
    monkeypatch.setattr(extraction, "OpenAI", lambda **kw: client)
    with pytest.raises(extraction.ExtractionFailure, match="No decision was made"):
        extraction.extract(b"test-only PDF bytes")


def test_schema_rejects_incomplete_output():
    with pytest.raises(ValidationError):
        Extraction.model_validate({"total": "1200", "invented_approval": True})


def test_missing_configuration_has_no_fallback(monkeypatch):
    monkeypatch.setattr(extraction, "settings", SimpleNamespace(api_key="", model=""))
    with pytest.raises(extraction.ExtractionFailure, match="not configured"):
        extraction.extract(b"test-only PDF bytes")
