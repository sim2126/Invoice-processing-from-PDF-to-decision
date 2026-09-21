import copy
from decimal import Decimal

import pytest
from ap.documents import find_quote, value_supported, verify_evidence
from ap.rules import decimal, identity, price_allowed
from hypothesis import given
from hypothesis import strategies as st


def test_clean_partial(facts, decide):
    result = decide(facts)
    assert result["outcome"] == "APPROVED"
    assert result["comparison"]["remaining_after"] == "2800.00"
    assert result["allocations"] == {"PAPER-A4": "12"}


@pytest.mark.parametrize(
    "value", ["NaN", "Infinity", "-Infinity", "1e10", "--1", "abc", None, True, 1.2, "1.0000001"]
)
def test_invalid_decimal(value):
    assert decimal(value) is None


@pytest.mark.parametrize(
    "approved,actual,allowed",
    [
        ("100", "101", True),
        ("100", "101.01", False),
        ("200", "201", True),
        ("200", "201.01", False),
        ("50", "50.50", True),
        ("50", "50.51", False),
        ("100", "99", True),
        ("0", "0", False),
        ("100", "-1", False),
    ],
)
def test_price_and_boundary(approved, actual, allowed):
    assert price_allowed(Decimal(actual), Decimal(approved)) is allowed


@pytest.mark.parametrize("field", ["invoice_number", "invoice_date", "currency", "total"])
def test_missing_mandatory(facts, decide, field):
    facts[field] = None
    assert decide(facts)["outcome"] == "NEEDS_REVIEW"


@pytest.mark.parametrize(
    "field,value",
    [
        ("total", "0"),
        ("total", "-100"),
        ("invoice_date", "09/10/2026"),
        ("invoice_date", "2028-01-01"),
        ("currency", "EUR"),
        ("document_kind", "credit_note"),
        ("invoice_count", 2),
        ("tax_treatment", "ambiguous"),
    ],
)
def test_unsupported(facts, decide, field, value):
    facts[field] = value
    assert decide(facts)["outcome"] == "NEEDS_REVIEW"


def test_overrun(facts, decide):
    facts["total"] = facts["subtotal"] = facts["lines"][0]["total"] = "4500.00"
    facts["lines"][0]["quantity"] = "45"
    result = decide(facts)
    assert result["outcome"] == "NEEDS_REVIEW"
    assert result["comparison"]["shortfall"] == "500.00"
    assert result["comparison"]["remaining_after"] == "4000.00"


def test_quantity_overbilling_despite_lower_total(facts, decide):
    facts["total"] = facts["subtotal"] = facts["lines"][0]["total"] = "2500.00"
    facts["lines"][0].update(quantity="50", unit_price="50")
    result = decide(facts)
    assert result["outcome"] == "NEEDS_REVIEW"
    assert any(
        c["code"] == "quantity_PAPER-A4" and c["state"] == "review" for c in result["checks"]
    )


@pytest.mark.parametrize("delta,expected", [("0.01", "APPROVED"), ("0.02", "NEEDS_REVIEW")])
def test_rounding(facts, decide, delta, expected):
    facts["total"] = str(Decimal(facts["total"]) + Decimal(delta))
    assert decide(facts)["outcome"] == expected


def test_tolerance_never_extends_po_ceiling(facts, decide):
    facts["subtotal"] = facts["lines"][0]["total"] = "4000.00"
    facts["lines"][0]["quantity"] = "40"
    facts["total"] = "4000.01"
    assert decide(facts)["outcome"] == "NEEDS_REVIEW"


def test_ambiguity_then_selection(facts, decide, financial):
    facts["po_reference"] = None
    second = copy.deepcopy(financial[1][0])
    second.update(id="p2", reference="PO-OTHER")
    financial[1].append(second)
    assert decide(facts)["outcome"] == "NEEDS_REVIEW"
    assert decide(facts, selections={"po_id": "p1"})["outcome"] == "APPROVED"


def test_inactive_vendor_blocker_survives_correction(facts, decide, financial):
    financial[0][0]["active"] = False
    facts["total"] = None
    assert decide(facts, selections={"vendor_id": "v1"})["outcome"] == "BLOCKED"


def test_closed_po(facts, decide, financial):
    financial[1][0]["status"] = "CLOSED"
    assert decide(facts)["outcome"] == "BLOCKED"


def test_unknown_vendor(facts, decide):
    facts.update(vendor_name="Unregistered", vendor_identifier="UNKNOWN")
    assert decide(facts)["outcome"] == "NEEDS_REVIEW"


def test_vendor_po_conflict(facts, decide, financial):
    financial[1][0]["vendor_id"] = "another"
    assert decide(facts)["outcome"] == "NEEDS_REVIEW"


def test_ambiguous_line_and_unit(facts, decide):
    facts["lines"][0].update(sku=None, description="Bundled supplies", unit="box")
    assert decide(facts)["outcome"] == "NEEDS_REVIEW"


@pytest.mark.parametrize("changed,expected", [(False, "BLOCKED"), (True, "NEEDS_REVIEW")])
def test_business_collision(facts, decide, financial, changed, expected):
    financial[3].append(
        {
            "vendor_id": "v1",
            "reference": "ALD-NEW",
            "total": "1201" if changed else "1200",
            "date": "2026-09-15",
            "currency": "USD",
            "invoice_id": "original",
        }
    )
    result = decide(facts)
    assert result["outcome"] == expected
    assert result["duplicate_id"] == "original"


def test_same_number_different_vendor(facts, decide, financial):
    financial[3].append({"vendor_id": "v2", "reference": "ALD-NEW"})
    assert decide(facts)["outcome"] == "APPROVED"


def test_strong_identity_preserves_significant_characters():
    assert identity(" A-001 ") == "a-001"
    assert identity("A-001") != identity("A001") != identity("A1")


def test_suspicious_identifier_review(facts, decide, financial):
    financial[3].append({"vendor_id": "v1", "reference": "ALDNEW"})
    assert decide(facts)["outcome"] == "NEEDS_REVIEW"


def test_discount_shipping_once(facts, decide):
    facts.update(header_discount="100", shipping="20", total="1120")
    assert decide(facts)["outcome"] == "APPROVED"


def test_inclusive_tax(facts, decide):
    facts.update(tax_treatment="inclusive", tax_rate="10", tax="120", subtotal="1320", total="1320")
    facts["lines"][0].update(unit_price="110", total="1320")
    result = decide(facts)
    assert result["outcome"] == "APPROVED"
    assert result["comparison"]["normalized"] == {
        "net": "1200.00",
        "tax": "120.00",
        "gross": "1320.00",
    }


def test_absent_optional_is_recorded_assumption(facts, decide):
    facts.update(tax=None, shipping=None, header_discount=None)
    result = decide(facts)
    assert result["outcome"] == "APPROVED"
    assert any(c["code"] == "assumptions" for c in result["checks"])


@given(
    st.decimals(
        min_value="0.01", max_value="10000", places=2, allow_nan=False, allow_infinity=False
    )
)
def test_and_tolerance_invariant(price):
    upper = price + min(Decimal("1"), price * Decimal("0.01"))
    assert price_allowed(upper, price)
    assert not price_allowed(upper + Decimal("0.000001"), price)


def test_no_evidence_never_approves(facts, decide):
    assert decide(facts, evidence=[])["outcome"] == "NEEDS_REVIEW"


def test_evidence_and_remaining_ceiling_invariants(facts, decide):
    @given(st.decimals(min_value="0.01", max_value="10000", places=2))
    def check(total):
        data = copy.deepcopy(facts)
        data["total"] = data["subtotal"] = str(total)
        data["lines"][0].update(quantity=str(total / 100), total=str(total))
        result = decide(data)
        assert (result["outcome"] == "APPROVED") == (total <= Decimal("4000"))
        assert decide(data, evidence=[])["outcome"] == "NEEDS_REVIEW"
        if result["outcome"] == "APPROVED":
            assert Decimal(result["comparison"]["remaining_after"]) >= 0

    check()


def test_source_value_must_match():
    assert value_supported("1200", "Total USD: 1,200.00", "total")
    assert not value_supported("1200", "Total USD: 1,900.00", "total")
    assert not value_supported("2026-09-10", "09/10/2026", "invoice_date")
    assert value_supported("2026-09-15", "September 15, 2026", "invoice_date")


def test_real_coordinates_only():
    page = {
        "page": 1,
        "width": 100,
        "height": 100,
        "method": "native",
        "words": [
            {"text": "Total", "x0": 5, "top": 10, "x1": 25, "bottom": 20},
            {"text": "1200.00", "x0": 30, "top": 10, "x1": 70, "bottom": 20},
        ],
    }
    assert find_quote(page, "Total 1200.00") == [0.05, 0.1, 0.7, 0.2]
    assert find_quote(page, "Total 900.00") is None
    data = {
        "total": "900",
        "evidence": [{"field": "total", "page": 1, "quote": "Total 1200.00", "raw": "900"}],
    }
    assert verify_evidence(data, [page])[0]["status"] == "unverified"
