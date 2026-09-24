"""Exercise the AI trust boundary, not the provider's wording."""

import copy
from types import SimpleNamespace

import pytest
from ap import assistant
from openai.lib._pydantic import to_strict_json_schema
from pydantic import ValidationError


def context(facts, financial):
    data = copy.deepcopy(facts)
    data["po_reference"], data["po_references"] = None, []
    vendors, orders, *_ = copy.deepcopy(financial)
    orders.append({**orders[0], "id": "p2", "reference": "PO-1099"})
    quote = "Invoice ALD-NEW for supplier ALDER-001 is assigned to PO-1042."
    result = {
        "status": "ready",
        "suggested_po_id": "p1",
        "sources": [{"kind": "document", "document_id": "d1", "quote": quote}],
    }
    docs = {"d1": [{"page": 1, "text": quote}]}
    return data, vendors, orders, result, docs


def test_only_explicit_reference_binding_can_auto_match(facts, financial):
    data, vendors, orders, result, docs = context(facts, financial)
    assert assistant.grounded_po(data, {}, result, vendors, orders, docs) == "p1"
    result["sources"][0]["quote"] = "The amounts look similar."
    assert assistant.grounded_po(data, {}, result, vendors, orders, docs) is None


@pytest.mark.parametrize(
    "quote",
    [
        "Invoice ALD-NEW from supplier ALDER-001 is not assigned to PO-1042.",
        "Invoice ALD-NEW is from ALDER-001. A different invoice is assigned to PO-1042.",
    ],
)
def test_identifier_mentions_and_negative_assignments_do_not_authorize_a_match(
    facts, financial, quote
):
    data, vendors, orders, result, docs = context(facts, financial)
    result["sources"][0]["quote"] = quote
    docs["d1"][0]["text"] = quote
    assert assistant.grounded_po(data, {}, result, vendors, orders, docs) is None


@pytest.mark.parametrize(
    "change",
    [
        "printed",
        "human",
        "archived",
        "conflict",
        "wrong_invoice",
        "wrong_vendor",
        "closed",
        "currency",
    ],
)
def test_auto_match_cannot_override_facts_or_conflicts(facts, financial, change):
    data, vendors, orders, result, docs = context(facts, financial)
    selections = {}
    if change == "printed":
        data["po_reference"] = "PO-1099"
    if change == "human":
        selections["po_id"] = "p2"
    if change == "archived":
        docs = {}
    if change == "conflict":
        docs["d2"] = [{"page": 1, "text": "ALD-NEW ALDER-001 belongs to PO-1099."}]
    if change == "wrong_invoice":
        data["invoice_number"] = "ALD-NE"
    if change == "wrong_vendor":
        data["vendor_identifier"], data["vendor_name"] = "other", "other"
    if change == "closed":
        orders[0]["status"] = "CLOSED"
    if change == "currency":
        data["currency"] = "EUR"
    assert assistant.grounded_po(data, selections, result, vendors, orders, docs) is None


@pytest.mark.parametrize("citation", ["unknown_id", "missing", "valid"])
def test_model_citations_must_be_present_in_retrieved_sources(monkeypatch, citation):
    quotes = (
        []
        if citation == "missing"
        else [
            assistant.SourceQuote(
                source_id="unknown" if citation == "unknown_id" else "policy",
            )
        ]
    )
    output = assistant.Recommendation(
        explanation="Example",
        next_step="Review",
        suggested_po_id=None,
        question=None,
        draft_message=None,
        citations=quotes,
    )
    monkeypatch.setattr(
        assistant,
        "OpenAI",
        lambda **kw: SimpleNamespace(
            responses=SimpleNamespace(
                parse=lambda **kw: SimpleNamespace(
                    status="completed", output_parsed=output, model="test", usage=None
                )
            )
        ),
    )

    def recommend():
        return assistant.recommend(
            {},
            {},
            [{"id": "policy", "kind": "policy", "title": "Policy", "text": "Exact policy text"}],
            [],
        )

    if citation == "valid":
        assert recommend()["sources"][0]["quote"] == "Exact policy text"
    else:
        with pytest.raises(ValueError):
            recommend()


@pytest.mark.parametrize("candidate_ids", [[], ["po-1"], ["po-1", "po-2"]])
def test_provider_schema_restricts_ids_to_current_retrieval(monkeypatch, candidate_ids):
    captured = {}
    answer = {
        "explanation": "The invoice needs review.",
        "next_step": "Confirm its assignment.",
        "suggested_po_id": candidate_ids[0] if candidate_ids else None,
        "question": None,
        "draft_message": None,
        "citations": [{"source_id": "policy"}],
    }

    def parse(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            status="completed",
            output_parsed=kwargs["text_format"].model_validate(answer),
            model="test",
            usage=None,
        )

    monkeypatch.setattr(
        assistant,
        "OpenAI",
        lambda **kwargs: SimpleNamespace(responses=SimpleNamespace(parse=parse)),
    )
    result = assistant.recommend(
        {},
        {},
        [
            {
                "id": "invoice:1:0",
                "kind": "invoice",
                "title": "Invoice source",
                "text": "Original invoice text",
            },
            {"id": "policy", "kind": "policy", "title": "Policy", "text": "Exact policy text"},
        ],
        [{"id": value} for value in candidate_ids],
    )
    assert result["sources"][0]["quote"] == "Exact policy text"
    response_format = captured["text_format"]
    assert issubclass(response_format, assistant.Recommendation)
    schema = to_strict_json_schema(response_format)
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    citations_schema = schema["properties"]["citations"]
    quote_schema = schema["$defs"][citations_schema["items"]["$ref"].rsplit("/", 1)[1]]
    assert quote_schema["additionalProperties"] is False
    assert quote_schema["required"] == ["source_id"]
    assert quote_schema["properties"]["source_id"]["enum"] == [
        "invoice:1:0",
        "policy",
        "checks",
    ]
    assert citations_schema["minItems"] == 1
    assert citations_schema["maxItems"] == 8
    po_schema = schema["properties"]["suggested_po_id"]
    if candidate_ids:
        assert {"type": "null"} in po_schema["anyOf"]
        allowed = next(item for item in po_schema["anyOf"] if item["type"] == "string")
        assert allowed["enum"] == candidate_ids
    else:
        assert po_schema["type"] == "null"
    for candidate_id in [None, *candidate_ids]:
        response_format.model_validate({**answer, "suggested_po_id": candidate_id})
    for source_id in ["invoice:1:0", "policy", "checks"]:
        response_format.model_validate({**answer, "citations": [{"source_id": source_id}]})
    with pytest.raises(ValidationError):
        response_format.model_validate({**answer, "suggested_po_id": "other-workspace-po"})
    with pytest.raises(ValidationError):
        response_format.model_validate({**answer, "citations": [{"source_id": "invented"}]})
    with pytest.raises(ValidationError):
        response_format.model_validate({**answer, "citations": []})


def test_checks_only_schema_has_a_single_source_enum(monkeypatch):
    def parse(**kwargs):
        response_format = kwargs["text_format"]
        schema = to_strict_json_schema(response_format)
        quote_ref = schema["properties"]["citations"]["items"]["$ref"]
        quote_schema = schema["$defs"][quote_ref.rsplit("/", 1)[1]]
        assert quote_schema["properties"]["source_id"]["enum"] == ["checks"]
        assert "const" not in quote_schema["properties"]["source_id"]
        return SimpleNamespace(
            status="completed",
            output_parsed=response_format.model_validate(
                {
                    "explanation": "Review required.",
                    "next_step": "Obtain the missing document.",
                    "suggested_po_id": None,
                    "question": None,
                    "draft_message": None,
                    "citations": [{"source_id": "checks"}],
                }
            ),
            model="test",
            usage=None,
        )

    monkeypatch.setattr(
        assistant,
        "OpenAI",
        lambda **kwargs: SimpleNamespace(responses=SimpleNamespace(parse=parse)),
    )
    result = assistant.recommend({}, {"checks": [{"message": "Missing document"}]}, [], [])
    assert result["sources"][0]["quote"] == "Missing document"


def test_server_still_rejects_unknown_po_from_unconstrained_provider_output(monkeypatch):
    output = assistant.Recommendation(
        explanation="Example",
        next_step="Review",
        suggested_po_id="other-workspace-po",
        question=None,
        draft_message=None,
        citations=[assistant.SourceQuote(source_id="policy")],
    )
    monkeypatch.setattr(
        assistant,
        "OpenAI",
        lambda **kwargs: SimpleNamespace(
            responses=SimpleNamespace(
                parse=lambda **kwargs: SimpleNamespace(
                    status="completed", output_parsed=output, model="test", usage=None
                )
            )
        ),
    )
    with pytest.raises(ValueError, match="unknown purchase order"):
        assistant.recommend(
            {},
            {},
            [{"id": "policy", "kind": "policy", "title": "Policy", "text": "Exact policy text"}],
            [{"id": "po-1"}],
        )
