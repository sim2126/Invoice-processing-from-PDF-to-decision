"""Exercise the AI trust boundary, not the provider's wording."""

import copy
from types import SimpleNamespace

import pytest
from ap import assistant


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
