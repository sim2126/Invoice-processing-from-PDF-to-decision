"""Groups, reasons and progress messages derived from the real rules engine's checks."""

import copy

import pytest
from ap.checks import (
    GROUPS,
    REASONS,
    check_group,
    comparison_view,
    group_events,
    po_source,
    read_message,
    reason_for,
    with_groups,
)


@pytest.mark.parametrize(
    "code,group",
    [
        ("scope", "document"),
        ("extraction_warning", "document"),
        ("required_invoice_number", "document"),
        ("evidence", "document"),
        ("date", "document"),
        ("currency", "document"),
        ("positive_total", "document"),
        ("precision", "document"),
        ("something_new", "document"),
        ("vendor", "supplier"),
        ("po", "po"),
        ("lines", "lines"),
        ("line_0", "lines"),
        ("line_match_3", "lines"),
        ("price_12", "lines"),
        ("tax_treatment", "totals"),
        ("tax_amount", "totals"),
        ("net_amount", "totals"),
        ("tax_rate_amount", "totals"),
        ("zero_tax", "totals"),
        ("arithmetic", "totals"),
        ("subtotal", "totals"),
        ("assumptions", "totals"),
        ("duplicate", "duplicate"),
        ("budget", "budget"),
        ("quantity_PAPER-A4", "budget"),
    ],
)
def test_check_group_mapping(code, group):
    assert check_group(code) == group


def test_every_check_from_the_engine_has_a_group(facts, decide):
    for check in with_groups(decide(facts)["checks"]):
        assert check["group"] in GROUPS


def stages(result, data):
    return {stage: (state, message) for stage, state, message in group_events(result, data)}


def test_clean_invoice_passes_every_group_with_plain_summaries(facts, decide):
    result = decide(facts)
    assert result["outcome"] == "APPROVED"
    assert reason_for(result["checks"], facts) is None
    events = group_events(result, facts, po_source=po_source(facts, {}))
    assert [stage for stage, _, _ in events] == [f"check:{g}" for g in GROUPS]
    assert all(state == "passed" for _, state, _ in events)
    by_stage = {stage: message for stage, _, message in events}
    assert by_stage["check:supplier"] == "Alder Office Supply · ALDER-001"
    assert by_stage["check:po"] == "PO-1042 · Office supplies · printed on the invoice"
    assert by_stage["check:lines"] == "PAPER-A4 · 12 cases at $100.00, the order price"
    assert by_stage["check:totals"] == "Lines $1,200.00 + tax $0.00 = total $1,200.00"
    assert by_stage["check:duplicate"] == "No earlier ALD-NEW from Alder Office Supply"
    assert by_stage["check:budget"] == "$4,000.00 left on PO-1042 · $2,800.00 after this invoice"
    assert by_stage["check:document"].endswith("each value linked to the page")


def test_over_budget_reason_and_budget_group(facts, decide):
    facts["total"] = facts["subtotal"] = facts["lines"][0]["total"] = "4500.00"
    facts["lines"][0]["quantity"] = "45"
    result = decide(facts)
    assert reason_for(result["checks"], facts) == "budget"
    state, message = stages(result, facts)["check:budget"]
    assert state == "review"
    assert message.startswith("Only $4,000.00 remains on this PO")
    # Cumulative quantity is part of the budget group, not the line match.
    assert stages(result, facts)["check:lines"][0] == "passed"


def test_missing_po_is_nopo_with_review_po_group(facts, decide, financial):
    facts["po_reference"], facts["po_references"] = None, []
    second = copy.deepcopy(financial[1][0])
    second.update(id="p2", reference="PO-1099")
    financial[1].append(second)
    result = decide(facts)
    assert reason_for(result["checks"], facts) == "nopo"
    assert stages(result, facts)["check:po"] == (
        "review",
        "2 supported purchase orders. Select the correct order and record why.",
    )
    # Lines and budget can't be judged without an order; never a ✓ "matches".
    assert stages(result, facts)["check:lines"] == ("skipped", "Waiting for a purchase order")
    assert stages(result, facts)["check:budget"] == ("skipped", "Waiting for a purchase order")
    approved = decide(facts, selections={"po_id": "p1"})
    assert approved["outcome"] == "APPROVED"
    po = group_events(approved, facts, po_source=po_source(facts, {"po_id": "p1"}))[2]
    assert po == ("check:po", "passed", "PO-1042 · Office supplies · confirmed by a reviewer")


def test_printed_unknown_po_is_a_purchase_order_issue(facts, decide):
    facts["po_reference"] = "PO-9999"
    result = decide(facts)
    assert reason_for(result["checks"], facts) == "po"
    po = next(c for c in result["checks"] if c["code"] == "po")
    # Never reads as "no PO printed" when one is printed.
    assert po["message"] == (
        "PO-9999 was not found among this workspace's orders. "
        "1 supported purchase orders. Select the correct order and record why."
    )


@pytest.mark.parametrize("printed", [True, False])
def test_unconfirmed_supplier_waits_instead_of_judging_orders(facts, decide, printed):
    facts.update(vendor_name="Alder Office Supplies Inc", vendor_identifier=None)
    if not printed:
        facts["po_reference"], facts["po_references"] = None, []
    result = decide(facts)
    assert result["vendor_id"] is None
    assert reason_for(result["checks"], facts) == "vendor"
    events = stages(result, facts)
    assert events["check:supplier"][0] == "review"
    assert events["check:po"] == (
        "skipped",
        "PO-1042 printed · waiting for the supplier to be confirmed"
        if printed
        else "Waiting for the supplier to be confirmed",
    )
    assert events["check:lines"] == ("skipped", "Waiting for the supplier to be confirmed")
    assert events["check:budget"] == ("skipped", "Waiting for the supplier to be confirmed")
    po = next(c for c in result["checks"] if c["code"] == "po")
    assert "supplier is confirmed" in po["message"]
    assert not po["message"].startswith(("No supported", "1 supported"))
    # Once a person confirms the supplier, the printed order is matched as usual.
    if printed:
        confirmed = decide(facts, selections={"vendor_id": "v1"})
        assert confirmed["outcome"] == "APPROVED"
        assert stages(confirmed, facts)["check:po"][0] == "passed"


def test_closed_po_is_blocked_and_closed(facts, decide, financial):
    financial[1][0]["status"] = "CLOSED"
    result = decide(facts)
    assert result["outcome"] == "BLOCKED"
    assert reason_for(result["checks"], facts) == "closed"
    assert stages(result, facts)["check:po"][0] == "blocked"
    # A blocked invoice reserves nothing, so no balance "after this invoice".
    assert stages(result, facts)["check:budget"] == (
        "skipped",
        "Nothing is reserved for a blocked invoice",
    )


def test_tax_inclusive_prices_are_compared_net_and_said_so(facts, decide):
    facts.update(tax_treatment="inclusive", tax_rate="10", tax="120", subtotal="1320", total="1320")
    facts["lines"][0].update(unit_price="110", total="1320")
    result = decide(facts)
    assert result["outcome"] == "APPROVED"
    assert result["comparison"]["normalized"] == {
        "net": "1200.00",
        "tax": "120.00",
        "gross": "1320.00",
    }
    row = result["comparison"]["lines"][0]
    assert (row["invoice_printed_price"], row["invoice_net_price"], row["po_price"]) == (
        "110.00",
        "100.00",
        "100.00",
    )
    assert row["invoice_price"] == "100.00"  # always the net price compared with the order
    price = next(c for c in result["checks"] if c["code"] == "price_0")
    assert price["message"].startswith("Invoice $110.00 incl. 10% tax = $100.00 net / PO $100.00.")
    events = stages(result, facts)
    assert events["check:lines"] == (
        "passed",
        "PAPER-A4 · 12 cases at $110.00 incl. 10% tax → $100.00 net, the order price",
    )
    assert events["check:totals"] == (
        "passed",
        "Lines $1,320.00 incl. 10% tax = total $1,320.00 · $1,200.00 net + $120.00 tax",
    )
    # The order's budget counts the full amount including tax.
    assert events["check:budget"] == (
        "passed",
        "$4,000.00 left on PO-1042 · $2,680.00 after this invoice",
    )


def test_tax_exclusive_rows_carry_the_same_printed_and_net_price(facts, decide):
    row = decide(facts)["comparison"]["lines"][0]
    assert row["invoice_printed_price"] == row["invoice_net_price"] == "100.00"


def test_earlier_decisions_gain_printed_and_net_prices():
    comparison = {
        "po_reference": "PO-1103",
        "lines": [{"sku": "MONITOR-27", "invoice_price": "300.00", "po_price": "300.00"}],
    }
    extraction = {"lines": [{"sku": "monitor-27", "unit_price": "330"}]}
    view = comparison_view(comparison, extraction)
    assert view["lines"][0]["invoice_net_price"] == "300.00"
    assert view["lines"][0]["invoice_printed_price"] == "330.00"
    assert view["po_reference"] == "PO-1103"
    assert "invoice_net_price" not in comparison["lines"][0]  # stored record untouched
    assert comparison_view({}, {}) == {"lines": []}


def test_read_message_says_how_the_page_was_read():
    assert read_message([{"method": "native"}]) == "Text layer found · no OCR needed"
    assert read_message([{"method": "ocr"}]) == "Scanned page · text recognised with OCR · 1 page"
    assert read_message([{"method": "ocr"}, {"method": "ocr"}]) == (
        "Scanned pages · text recognised with OCR · 2 pages"
    )


def test_inactive_supplier(facts, decide, financial):
    financial[0][0]["active"] = False
    result = decide(facts)
    assert reason_for(result["checks"], facts) == "inactive"
    assert stages(result, facts)["check:supplier"] == (
        "blocked",
        "Alder Office Supply is inactive in the approved register.",
    )


def test_unknown_supplier(facts, decide):
    facts.update(vendor_name="Unregistered", vendor_identifier="UNKNOWN")
    assert reason_for(decide(facts)["checks"], facts) == "vendor"


@pytest.mark.parametrize("changed,reason", [(False, "duplicate"), (True, "duplicate")])
def test_duplicate_reason(facts, decide, financial, changed, reason):
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
    assert reason_for(result["checks"], facts) == reason
    assert stages(result, facts)["check:duplicate"][0] == ("review" if changed else "blocked")


def test_missing_invoice_number(facts, decide):
    facts["invoice_number"] = None
    result = decide(facts)
    assert reason_for(result["checks"], facts) == "nonumber"
    assert stages(result, facts)["check:document"] == (
        "review",
        "Confirm the missing invoice number from the source.",
    )


def test_price_above_tolerance(facts, decide):
    facts["lines"][0].update(unit_price="101.01", total="1212.12")
    facts["subtotal"] = facts["total"] = "1212.12"
    result = decide(facts)
    assert reason_for(result["checks"], facts) == "price"
    assert stages(result, facts)["check:lines"][0] == "review"


def test_totals_that_do_not_add_up(facts, decide):
    facts["total"] = "1320.00"
    result = decide(facts)
    assert reason_for(result["checks"], facts) == "totals"
    state, message = stages(result, facts)["check:totals"]
    assert state == "review"
    assert message.startswith("Calculated $1,200.00 / stated $1,320.00")


def test_specific_reason_wins_over_unverified_evidence(facts, decide):
    facts["total"] = "1320.00"
    evidence = [{"field": "invoice_number", "status": "observed"}]
    result = decide(facts, evidence=evidence)
    assert reason_for(result["checks"], facts) == "totals"
    state, message = stages(result, facts)["check:document"]
    assert state == "review"
    assert message.startswith("Not found on the page: ")
    assert "line 1 unit price" in message and "supplier ID" in message


def test_only_unverified_evidence_is_evidence(facts, decide):
    result = decide(facts, evidence=[])
    assert reason_for(result["checks"], facts) == "evidence"


def test_item_not_on_order(facts, decide):
    facts["lines"][0].update(sku=None, description="Bundled supplies", unit="box")
    assert reason_for(decide(facts)["checks"], facts) == "item"


def test_other_reasons_need_clarification(facts, decide):
    facts["invoice_date"] = "2028-01-01"
    assert reason_for(decide(facts)["checks"], facts) == "other"


def test_every_reason_has_a_label():
    assert set(REASONS) == {
        "nopo",
        "budget",
        "price",
        "totals",
        "duplicate",
        "closed",
        "inactive",
        "nonumber",
        "item",
        "vendor",
        "evidence",
        "po",
        "other",
    }


def test_group_state_is_the_worst_state_and_skipped_only_when_all_skipped():
    def result(*checks):
        return {
            "checks": list(checks),
            "comparison": {},
            "candidates": {},
            "vendor_id": "v1",
            "po_id": "p1",
            "outcome": "NEEDS_REVIEW",
        }

    review = {"code": "budget", "state": "review", "message": "Only $1.00 remains."}
    passed = {"code": "quantity_X", "state": "passed", "message": "Fine."}
    skipped = {"code": "budget", "state": "skipped", "message": "Not needed."}
    events = dict((s, (st, m)) for s, st, m in group_events(result(passed, review), {}))
    assert events["check:budget"] == ("review", "Only $1.00 remains.")
    events = dict((s, (st, m)) for s, st, m in group_events(result(skipped), {}))
    assert events["check:budget"][0] == "skipped"
    events = dict((s, (st, m)) for s, st, m in group_events(result(skipped, passed), {}))
    assert events["check:budget"][0] == "passed"
    assert events["check:duplicate"][0] == "skipped"
