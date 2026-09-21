from datetime import date

import pytest
from ap.rules import evaluate


@pytest.fixture
def facts():
    return {
        "vendor_name": "Alder Office Supply",
        "vendor_identifier": "ALDER-001",
        "invoice_number": "ALD-NEW",
        "invoice_date": "2026-09-15",
        "due_date": None,
        "po_reference": "PO-1042",
        "currency": "USD",
        "subtotal": "1200.00",
        "header_discount": "0.00",
        "shipping": "0.00",
        "tax": "0.00",
        "tax_rate": "0",
        "total": "1200.00",
        "tax_treatment": "exclusive",
        "document_kind": "invoice",
        "invoice_count": 1,
        "po_references": ["PO-1042"],
        "warnings": [],
        "evidence": [],
        "lines": [
            {
                "description": "Copy paper, case",
                "sku": "PAPER-A4",
                "quantity": "12",
                "unit": "case",
                "unit_price": "100.00",
                "discount": "0.00",
                "total": "1200.00",
            }
        ],
    }


@pytest.fixture
def financial():
    vendors = [
        {
            "id": "v1",
            "name": "Alder Office Supply",
            "identifier": "ALDER-001",
            "active": True,
            "aliases": [],
        }
    ]
    orders = [
        {
            "id": "p1",
            "reference": "PO-1042",
            "description": "Office supplies",
            "vendor_id": "v1",
            "currency": "USD",
            "status": "ACTIVE",
            "ceiling": "10000.00",
            "lines": [
                {
                    "sku": "PAPER-A4",
                    "description": "Copy paper, case",
                    "aliases": [],
                    "quantity": "100",
                    "unit": "case",
                    "unit_price": "100.00",
                }
            ],
        }
    ]
    commitments = [{"po_id": "p1", "amount": "6000.00", "quantities": {"PAPER-A4": "60"}}]
    return vendors, orders, commitments, []


def evidence_for(data):
    evidence = []
    for k, v in data.items():
        if isinstance(v, str):
            evidence.append({"field": k, "status": "observed"})
    for i, line in enumerate(data["lines"]):
        for k, v in line.items():
            if v is not None:
                evidence.append({"field": f"lines.{i}.{k}", "status": "observed"})
    return evidence


@pytest.fixture
def decide(financial):
    def run(facts, evidence=None, selections=None):
        return evaluate(
            facts,
            evidence if evidence is not None else evidence_for(facts),
            *financial,
            selections or {},
            date(2026, 9, 21),
        )

    return run
