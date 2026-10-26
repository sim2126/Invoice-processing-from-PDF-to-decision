"""PostgreSQL integration tests for human workflow, orders, the inbox and progress events."""

import copy
import hashlib
import io
import os
import secrets
from datetime import UTC, timedelta
from pathlib import Path
from zipfile import ZipFile

import pytest
from ap import pipeline
from ap.checks import GROUPS
from ap.config import settings
from ap.db import Invoice, Member, Revision, Run, Session, Workspace
from ap.main import app, events_payload
from ap.seed import seed_workspace
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from test_integration import client_for, finish, pending

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("AP_INTEGRATION") != "1",
        reason="Set AP_INTEGRATION=1 with the dedicated PostgreSQL test database",
    ),
]
INBOX = Path("fixtures/inbox")


@pytest.fixture(autouse=True)
def dedicated_database(monkeypatch):
    assert settings.database_url.endswith("/apdesk_test"), (
        "Integration tests require a separate apdesk_test database"
    )
    with Session.begin() as db:
        db.execute(text("UPDATE run SET state='FAILED' WHERE state IN ('QUEUED', 'RUNNING')"))
        # Daily quotas are shared by every run of this suite; start each test fresh.
        db.execute(text("DELETE FROM quota"))
    monkeypatch.setattr(pipeline.assistant, "recommend", lambda *args: {"status": "unavailable"})


@pytest.fixture
def workspace():
    with Session.begin() as db:
        w, token = seed_workspace(db)
        return w.id, token, w.csrf


def viewer_for(workspace_id):
    token = secrets.token_urlsafe(32)
    with Session.begin() as db:
        member = Member(
            workspace_id=workspace_id,
            name="Alex Rivera",
            email="alex@example.com",
            role="viewer",
            token_hash=hashlib.sha256(token.encode()).hexdigest(),
            csrf=secrets.token_urlsafe(32),
        )
        db.add(member)
        db.flush()
        return client_for((workspace_id, token, member.csrf))


def needs_review(workspace, facts):
    """Two Alder orders fit and none is printed: the invoice needs a person."""
    record = pending(workspace[0], facts)
    record[3]["po_reference"], record[3]["po_references"] = None, []
    assert finish(record) == "NEEDS_REVIEW"
    return record[0]


def approved(workspace, facts):
    record = pending(workspace[0], facts)
    assert finish(record) == "APPROVED"
    return record[0]


def blocked(workspace, facts):
    facts = copy.deepcopy(facts)
    facts["po_reference"], facts["po_references"] = "PO-0999", ["PO-0999"]
    record = pending(workspace[0], facts)
    assert finish(record) == "BLOCKED"
    return record[0]


HOLD = {
    "expected_revision": 1,
    "to": "Procurement",
    "message": "Please confirm which order covers these twelve cases.",
}


def test_hold_waits_on_someone_and_is_audited(workspace, facts):
    invoice_id = needs_review(workspace, facts)
    client, viewer = client_for(workspace), viewer_for(workspace[0])
    route = f"/invoices/{invoice_id}/hold"
    assert viewer.post(route, json=HOLD).status_code == 403
    assert client.post(route, json=HOLD, headers={"x-csrf-token": "wrong"}).status_code == 403
    assert (
        client.post(route, json=HOLD, headers={"origin": "https://wrong.example"}).status_code
        == 403
    )
    assert TestClient(app).post(route, json=HOLD).status_code in (401, 403)
    assert client.post(route, json={**HOLD, "message": "short"}).status_code == 422
    assert client.post(route, json={**HOLD, "to": "  "}).status_code == 422
    assert client.post(route, json={**HOLD, "expected_revision": 2}).status_code == 409
    response = client.post(route, json=HOLD)
    assert response.status_code == 200, response.text
    assert response.json() == {"id": invoice_id, "existing": False}
    detail = client.get(f"/invoices/{invoice_id}").json()
    row = detail["invoice"]
    assert row["status"] == "ON_HOLD"
    assert row["outcome"] == "NEEDS_REVIEW"
    assert row["reason_code"] == "nopo"
    assert row["reason"] == "No PO on the invoice"
    assert (row["workflow"], row["workflow_to"], row["workflow_note"]) == (
        "ON_HOLD",
        "Procurement",
        HOLD["message"],
    )
    assert row["workflow_by"] == "Prabhakar Kumar"
    assert row["workflow_at"]
    audit = next(a for a in detail["audit"] if a["action"] == "HOLD")
    assert audit["after"] == {"to": "Procurement", "message": HOLD["message"]}
    assert audit["reason"] == HOLD["message"]
    assert audit["actor"] == "Prabhakar Kumar"
    assert audit["revision"] == 1
    listed = {i["id"]: i for i in client.get("/invoices").json()["invoices"]}
    assert listed[invoice_id]["status"] == "ON_HOLD"
    # Already waiting: a second hold is a conflict, not an overwrite.
    assert client.post(route, json=HOLD).status_code == 409
    with Session() as db:
        assert db.get(Invoice, invoice_id).workflow_to == "Procurement"


def test_hold_requires_a_completed_decision_that_needs_review(workspace, facts):
    client = client_for(workspace)
    for invoice_id in (approved(workspace, facts), blocked(workspace, facts)):
        assert client.post(f"/invoices/{invoice_id}/hold", json=HOLD).status_code == 409
    running = pending(workspace[0], facts)[0]
    assert client.post(f"/invoices/{running}/hold", json=HOLD).status_code == 409
    assert client.post("/invoices/not-an-invoice/hold", json=HOLD).status_code == 404
    with Session.begin() as db:
        other, token = seed_workspace(db)
    stranger = client_for((other.id, token, other.csrf))
    invoice_id = needs_review(workspace, facts)
    assert stranger.post(f"/invoices/{invoice_id}/hold", json=HOLD).status_code == 404


def test_reject_closes_review_or_blocked_invoices_only(workspace, facts):
    client, viewer = client_for(workspace), viewer_for(workspace[0])
    reason = {"expected_revision": 1, "reason": "Not our order; billed to the wrong company."}
    # Approved invoices stay immutable; there is no reject (or approve-anyway) path.
    assert (
        client.post(f"/invoices/{approved(workspace, facts)}/reject", json=reason).status_code
        == 409
    )
    invoice_id = blocked(workspace, facts)
    route = f"/invoices/{invoice_id}/reject"
    assert viewer.post(route, json=reason).status_code == 403
    assert client.post(route, json={**reason, "reason": "no"}).status_code == 422
    assert client.post(route, json={**reason, "expected_revision": 3}).status_code == 409
    response = client.post(route, json=reason)
    assert response.status_code == 200, response.text
    assert response.json() == {"id": invoice_id, "existing": False}
    detail = client.get(f"/invoices/{invoice_id}").json()
    row = detail["invoice"]
    assert (row["status"], row["workflow"], row["outcome"]) == ("REJECTED", "REJECTED", "BLOCKED")
    assert row["workflow_note"] == reason["reason"]
    assert row["workflow_by"] == "Prabhakar Kumar"
    assert row["reason_code"] == "closed"
    audit = next(a for a in detail["audit"] if a["action"] == "REJECT")
    assert audit["before"] == {"workflow": None}
    assert audit["after"] == {"workflow": "REJECTED", "reason": reason["reason"]}
    assert audit["reason"] == reason["reason"]
    # Rejected invoices are closed: no second rejection, hold or new review.
    assert client.post(route, json=reason).status_code == 409
    assert client.post(f"/invoices/{invoice_id}/hold", json=HOLD).status_code == 409
    review = client.post(
        f"/invoices/{invoice_id}/review",
        json={"expected_revision": 1, "reason": "Try the checks again please."},
    )
    assert review.status_code == 409
    assert "rejected" in review.json()["detail"]


def test_reject_after_hold_clears_who_it_was_waiting_on(workspace, facts):
    client = client_for(workspace)
    invoice_id = needs_review(workspace, facts)
    assert client.post(f"/invoices/{invoice_id}/hold", json=HOLD).status_code == 200
    reason = {"expected_revision": 1, "reason": "Procurement says this was never ordered."}
    assert client.post(f"/invoices/{invoice_id}/reject", json=reason).status_code == 200
    detail = client.get(f"/invoices/{invoice_id}").json()
    assert detail["invoice"]["status"] == "REJECTED"
    assert detail["invoice"]["workflow_to"] is None
    audit = next(a for a in detail["audit"] if a["action"] == "REJECT")
    assert audit["before"] == {"workflow": "ON_HOLD"}


def test_review_clears_a_hold_and_reruns_every_check(workspace, facts):
    client = client_for(workspace)
    invoice_id = needs_review(workspace, facts)
    assert client.post(f"/invoices/{invoice_id}/hold", json=HOLD).status_code == 200
    order = client.get(f"/invoices/{invoice_id}").json()["candidates"]["orders"][0]
    response = client.post(
        f"/invoices/{invoice_id}/review",
        json={
            "expected_revision": 1,
            "po_id": order["id"],
            "reason": "Procurement confirmed the order for these cases.",
        },
    )
    assert response.status_code == 200, response.text
    detail = client.get(f"/invoices/{invoice_id}").json()
    row = detail["invoice"]
    assert (row["status"], row["workflow"], row["workflow_to"]) == ("CHECKING", None, None)
    audit = next(a for a in detail["audit"] if a["action"] == "REVIEW")
    assert audit["reason"] == (
        "Procurement confirmed the order for these cases. (Hold waiting on Procurement cleared.)"
    )
    assert audit["before"]["workflow"] == "ON_HOLD"
    assert audit["after"]["workflow"] is None
    with Session() as db:
        run_id = db.get(Invoice, invoice_id).current_run
    pipeline.process(run_id)
    row = client.get(f"/invoices/{invoice_id}").json()["invoice"]
    assert (row["status"], row["revision"], row["human_touched"]) == ("APPROVED", 2, True)
    assert row["reason_code"] is None
    assert row["first_reason_code"] == "nopo"
    assert row["first_reason"] == "No PO on the invoice"


def test_rows_carry_dates_status_and_source(workspace, facts):
    client = client_for(workspace)
    facts = copy.deepcopy(facts)
    facts["due_date"] = None
    invoice_id = approved(workspace, facts)
    row = client.get(f"/invoices/{invoice_id}").json()["invoice"]
    assert row["status"] == "APPROVED"
    assert (row["invoice_date"], row["due_date"], row["due_assumed"]) == (
        "2026-09-15",
        "2026-10-15",
        True,
    )
    assert row["source"] == "upload"
    assert row["reason_code"] is None and row["first_reason_code"] is None
    running = pending(workspace[0], facts)[0]
    assert client.get(f"/invoices/{running}").json()["invoice"]["status"] == "CHECKING"
    with Session.begin() as db:
        run = db.get(Run, db.get(Invoice, running).current_run)
        run.state, run.error = "FAILED", "The document could not be processed."
    assert client.get(f"/invoices/{running}").json()["invoice"]["status"] == "FAILED"


def test_decision_checks_have_groups(workspace, facts):
    client = client_for(workspace)
    invoice_id = approved(workspace, facts)
    checks = client.get(f"/invoices/{invoice_id}").json()["decision"]["checks"]
    groups = {check["code"]: check["group"] for check in checks}
    assert groups["vendor"] == "supplier"
    assert groups["po"] == "po"
    assert groups["line_0"] == "lines"
    assert groups["arithmetic"] == "totals"
    assert groups["duplicate"] == "duplicate"
    assert groups["budget"] == groups["quantity_PAPER-A4"] == "budget"
    assert groups["evidence"] == "document"


def test_purchase_orders_report_committed_and_remaining(workspace, facts):
    client = client_for(workspace)
    assert TestClient(app).get("/purchase-orders").status_code == 401
    orders = {o["reference"]: o for o in client.get("/purchase-orders").json()}
    assert sorted(orders) == [
        "PO-0999",
        "PO-1038",
        "PO-1042",
        "PO-1088",
        "PO-1091",
        "PO-1103",
        "PO-1120",
        "PO-1124",
        "PO-1131",
        "PO-1135",
    ]
    order = orders["PO-1042"]
    assert (order["ceiling"], order["committed"], order["remaining"]) == (
        "10000.00",
        "6000.00",
        "4000.00",
    )
    assert (order["status"], order["currency"], order["description"]) == (
        "ACTIVE",
        "USD",
        "Workspace essentials",
    )
    assert {k: v for k, v in order["vendor"].items() if k != "id"} == {
        "name": "Alder Office Supply",
        "identifier": "ALDER-001",
        "active": True,
    }
    assert order["lines"] == [
        {
            "sku": "PAPER-A4",
            "description": "Copy paper, case",
            "unit": "case",
            "unit_price": "100.00",
            "quantity": "100",
            "committed_quantity": "60",
            "remaining_quantity": "40",
        }
    ]
    assert orders["PO-0999"]["status"] == "CLOSED"
    assert orders["PO-1038"]["committed"] == "0.00"
    assert orders["PO-1135"]["lines"][0]["unit_price"] == "1.20"
    assert orders["PO-1124"]["lines"][0]["unit"] == "seat-month"
    assert orders["PO-1103"]["lines"][0]["description"] == "27-inch monitor"
    approved(workspace, facts)
    order = {o["reference"]: o for o in client.get("/purchase-orders").json()}["PO-1042"]
    assert (order["committed"], order["remaining"]) == ("7200.00", "2800.00")
    assert order["lines"][0]["committed_quantity"] == "72"
    assert order["lines"][0]["remaining_quantity"] == "28"
    with Session.begin() as db:
        other, token = seed_workspace(db)
    stranger = client_for((other.id, token, other.csrf))
    theirs = {o["reference"]: o for o in stranger.get("/purchase-orders").json()}
    assert theirs["PO-1042"]["committed"] == "6000.00"
    assert theirs["PO-1042"]["id"] != order["id"]


def test_inbox_lists_arrivals_and_checks_them_through_normal_intake(workspace):
    client, viewer = client_for(workspace), viewer_for(workspace[0])
    assert TestClient(app).get("/inbox").status_code == 401
    items = client.get("/inbox").json()
    assert [i["key"] for i in items] == [
        "clean",
        "tolerance",
        "duplicate",
        "budget",
        "nopo",
        "scan",
        "assignment",
    ]
    with Session() as db:
        opened = db.get(Workspace, workspace[0]).created_at.astimezone(UTC)
    # 07:42 is 110 minutes before the last arrival (09:32), which lands 20 minutes
    # before the workspace was opened.
    assert items[0] == {
        "key": "clean",
        "kind": "invoice",
        "sender": "billing@coastlinefreight.com",
        "subject": "Invoice CF-7815 · Portland LTL, 2 shipments",
        "received_at": (opened - timedelta(minutes=130)).isoformat(),
        "filename": "coastline-cf-7815.pdf",
        "invoice_id": None,
        "document_id": None,
    }
    assert [i["kind"] for i in items].count("invoice") == 6
    assert items[-1]["kind"] == "document"
    assert items[-1]["sender"] == "maya.patel@juniperlabs.com"
    source = (INBOX / "coastline-cf-7815.pdf").read_bytes()
    pdf = client.get("/inbox/clean/pdf")
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.headers["content-disposition"].startswith("inline")
    assert pdf.content == source
    assert viewer.get("/inbox").status_code == 200
    assert viewer.post("/inbox/clean/check").status_code == 403
    assert client.post("/inbox/clean/check", headers={"x-csrf-token": "wrong"}).status_code == 403
    assert client.post("/inbox/assignment/check").status_code == 409
    assert client.post("/inbox/clean/save").status_code == 409
    assert client.post("/inbox/not-a-message/check").status_code == 404
    assert client.get("/inbox/not-a-message/pdf").status_code == 404
    first = client.post("/inbox/clean/check")
    assert first.status_code == 200, first.text
    assert first.json()["existing"] is False
    invoice_id = first.json()["id"]
    assert client.post("/inbox/clean/check").json() == {"id": invoice_id, "existing": True}
    # The same file uploaded by hand is the same invoice: one intake, one fingerprint.
    uploaded = client.post(
        "/invoices", files={"file": ("again.pdf", source, "application/pdf")}
    ).json()
    assert uploaded == {"id": invoice_id, "existing": True}
    listed = {i["key"]: i for i in client.get("/inbox").json()}
    assert listed["clean"]["invoice_id"] == invoice_id
    assert listed["tolerance"]["invoice_id"] is None
    detail = client.get(f"/invoices/{invoice_id}").json()
    assert detail["invoice"]["source"] == "inbox"
    assert detail["invoice"]["status"] == "CHECKING"
    assert detail["invoice"]["filename"] == "coastline-cf-7815.pdf"
    assert detail["run"]["state"] == "QUEUED"
    assert [e["stage"] for e in detail["events"]] == ["intake"]
    upload = next(a for a in detail["audit"] if a["action"] == "UPLOAD")
    assert upload["after"]["source"] == "inbox"
    assert client.get(f"/invoices/{invoice_id}/source").content == source
    with Session() as db:
        assert db.get(Workspace, workspace[0]).uploads == 1
        assert db.get(Invoice, invoice_id).sha256 == hashlib.sha256(source).hexdigest()


def test_inbox_saves_the_assignment_as_a_company_document(workspace):
    client = client_for(workspace)
    saved = client.post("/inbox/assignment/save")
    assert saved.status_code == 200, saved.text
    document = saved.json()
    assert document["filename"] == "mer-2081-project-assignment.pdf"
    assert document["pages"] == 1
    assert document["uploaded_by"] == "Prabhakar Kumar"
    assert client.post("/inbox/assignment/save").json()["id"] == document["id"]
    assert [d["id"] for d in client.get("/documents").json()] == [document["id"]]
    listed = {i["key"]: i for i in client.get("/inbox").json()}
    assert listed["assignment"]["document_id"] == document["id"]
    assert listed["assignment"]["invoice_id"] is None
    source = client.get(f"/documents/{document['id']}/source").content
    assert source == (INBOX / "mer-2081-project-assignment.pdf").read_bytes()
    # Archiving removes it from the inbox's view; saving again restores it.
    assert client.delete(f"/documents/{document['id']}").status_code == 204
    assert {i["key"]: i for i in client.get("/inbox").json()}["assignment"]["document_id"] is None
    assert client.post("/inbox/assignment/save").json()["id"] == document["id"]


def stages_of(invoice_id):
    with Session() as db:
        return [e.stage for e in events_payload(db, invoice_id)]


def queue_existing_extraction(record):
    """Queue a run whose extraction is already recorded, so no model is called."""
    invoice_id, run_id, _, data, pages = record
    with Session.begin() as db:
        run = db.get(Run, run_id)
        run.state, run.attempt, run.lease_until, run.attempt_token = "QUEUED", 0, None, None
        db.get(Invoice, invoice_id).page_data = pages
        revision = db.scalar(select(Revision).where(Revision.invoice_id == invoice_id))
        revision.extraction = data


def test_preliminary_group_events_precede_assistance(workspace, facts, monkeypatch):
    record = pending(workspace[0], facts)
    queue_existing_extraction(record)
    seen = []

    def recommend(*args):
        seen.extend(stages_of(record[0]))
        return {"status": "unavailable"}

    monkeypatch.setattr(pipeline.assistant, "recommend", recommend)
    pipeline.process(record[1])
    group_stages = [f"check:{group}" for group in GROUPS]
    # Every group was reported before the assistant was asked anything.
    assert all(stage in seen for stage in group_stages)
    assert "decision" not in seen
    stages = stages_of(record[0])
    assert stages.index("check:document") < stages.index("assist")
    assert stages[-1] == "decision"
    assert stages[-1 - len(GROUPS) : -1] == group_stages
    assert sum(stage == "check:budget" for stage in stages) == 2


def test_group_events_are_reported_with_ai_assistance_off(workspace, facts, monkeypatch):
    with Session.begin() as db:
        db.get(Workspace, workspace[0]).company = {"ai_assistance": False}
    record = pending(workspace[0], facts)
    queue_existing_extraction(record)

    def unexpected(*args):
        raise AssertionError("assistance is disabled")

    monkeypatch.setattr(pipeline.assistant, "recommend", unexpected)
    pipeline.process(record[1])
    stages = stages_of(record[0])
    assert "assist" not in stages
    for group in GROUPS:
        assert stages.count(f"check:{group}") == 2
    assert stages.index("check:document") < stages.index("decision")
    with Session() as db:
        assert db.get(Run, record[1]).state == "COMPLETED"


def test_read_messages_say_how_the_page_was_read(workspace, facts):
    record = pending(workspace[0], facts)
    queue_existing_extraction(record)
    pipeline.process(record[1])
    with Session() as db:
        reads = [e for e in events_payload(db, record[0]) if e.stage == "read"]
    assert [(e.state, e.message) for e in reads] == [
        ("running", "Reading the source document."),
        ("passed", "Text layer found · no OCR needed"),
    ]


def test_decisions_carry_the_reason_they_stopped(workspace, facts):
    client = client_for(workspace)
    invoice_id = needs_review(workspace, facts)
    order = client.get(f"/invoices/{invoice_id}").json()["candidates"]["orders"][0]
    response = client.post(
        f"/invoices/{invoice_id}/review",
        json={"expected_revision": 1, "po_id": order["id"], "reason": "Procurement named it."},
    )
    assert response.status_code == 200, response.text
    with Session() as db:
        run_id = db.get(Invoice, invoice_id).current_run
    pipeline.process(run_id)
    detail = client.get(f"/invoices/{invoice_id}").json()
    assert (detail["decision"]["reason_code"], detail["decision"]["reason"]) == (None, None)
    first = detail["history"][-1]
    assert (first["outcome"], first["reason_code"], first["reason"]) == (
        "NEEDS_REVIEW",
        "nopo",
        "No PO on the invoice",
    )
    closed = client.get(f"/invoices/{blocked(workspace, facts)}").json()["decision"]
    assert (closed["reason_code"], closed["reason"]) == ("closed", "PO already closed")


def ai_review(client, invoice_id, revision):
    """The review endpoint with no corrections and no selections: an AI review."""
    response = client.post(
        f"/invoices/{invoice_id}/review",
        json={"expected_revision": revision, "reason": "Ask AI to check company documents."},
    )
    assert response.status_code == 200, response.text
    with Session() as db:
        invoice = db.get(Invoice, invoice_id)
        provenance = db.scalar(
            select(Revision.provenance).where(
                Revision.invoice_id == invoice_id, Revision.number == invoice.revision
            )
        )
        return invoice.current_run, provenance


def no_order_found(*args):
    return {
        "status": "ready",
        "explanation": "No company document names the order for this invoice.",
        "next_step": "Ask procurement which order it belongs to.",
        "suggested_po_id": None,
        "question": "Which order covers these cases?",
        "draft_message": None,
        "sources": [],
    }


def test_ai_review_without_a_match_records_what_it_checked(workspace, facts, monkeypatch):
    client = client_for(workspace)
    invoice_id = needs_review(workspace, facts)
    monkeypatch.setattr(pipeline.assistant, "recommend", no_order_found)
    run_id, provenance = ai_review(client, invoice_id, 1)
    assert provenance["ai_review"] is True
    pipeline.process(run_id)
    detail = client.get(f"/invoices/{invoice_id}").json()
    assert (detail["invoice"]["status"], detail["invoice"]["reason_code"]) == (
        "NEEDS_REVIEW",
        "nopo",
    )
    audit = next(a for a in detail["audit"] if a["action"] == "AI_NO_MATCH")
    assert (audit["actor"], audit["revision"], audit["run_id"]) == ("AI assistant", 2, run_id)
    assert audit["after"] == {"documents_checked": 0}
    assert audit["reason"] == "No company document assigns this invoice to an order (0 on file)."
    assert not any(a["action"] == "AI_MATCH" for a in detail["audit"])
    # A document assigning a different invoice is on file and counted, but matches nothing.
    pdf = Path("fixtures/pdfs/project-assignment.pdf").read_bytes()
    uploaded = client.post("/documents", files={"file": ("assignment.pdf", pdf, "application/pdf")})
    assert uploaded.status_code == 201, uploaded.text
    run_id, _ = ai_review(client, invoice_id, 2)
    pipeline.process(run_id)
    audits = client.get(f"/invoices/{invoice_id}").json()["audit"]
    found = [a["after"]["documents_checked"] for a in audits if a["action"] == "AI_NO_MATCH"]
    assert found == [1, 0]


def test_no_document_finding_is_claimed_without_an_ai_review(workspace, facts, monkeypatch):
    client = client_for(workspace)
    invoice_id = needs_review(workspace, facts)
    # The assistant was unavailable: nothing is claimed about the documents.
    run_id, provenance = ai_review(client, invoice_id, 1)
    pipeline.process(run_id)
    detail = client.get(f"/invoices/{invoice_id}").json()
    assert detail["decision"]["assistant"]["status"] == "unavailable"
    assert not any(a["action"].startswith("AI_") for a in detail["audit"])
    # Choosing the order is a person's decision, not an AI review.
    monkeypatch.setattr(pipeline.assistant, "recommend", no_order_found)
    order = detail["candidates"]["orders"][0]
    response = client.post(
        f"/invoices/{invoice_id}/review",
        json={"expected_revision": 2, "po_id": order["id"], "reason": "Procurement named it."},
    )
    assert response.status_code == 200, response.text
    with Session() as db:
        run_id = db.get(Invoice, invoice_id).current_run
        provenance = db.scalar(
            select(Revision.provenance).where(
                Revision.invoice_id == invoice_id, Revision.number == 3
            )
        )
    assert provenance["ai_review"] is False
    pipeline.process(run_id)
    detail = client.get(f"/invoices/{invoice_id}").json()
    assert detail["invoice"]["status"] == "APPROVED"
    assert not any(a["action"].startswith("AI_") for a in detail["audit"])


def test_unconfirmed_supplier_waits_and_keeps_the_printed_order(workspace, facts):
    facts = copy.deepcopy(facts)
    facts.update(vendor_name="Alder Office Supplies Inc", vendor_identifier=None)
    record = pending(workspace[0], facts)
    assert finish(record) == "NEEDS_REVIEW"
    client = client_for(workspace)
    detail = client.get(f"/invoices/{record[0]}").json()
    row = detail["invoice"]
    assert (row["reason_code"], row["vendor_id"], row["po_reference"]) == (
        "vendor",
        None,
        "PO-1042",
    )
    events = {e["stage"]: (e["state"], e["message"]) for e in detail["events"]}
    assert events["check:supplier"][0] == "review"
    assert events["check:po"] == (
        "skipped",
        "PO-1042 printed · waiting for the supplier to be confirmed",
    )
    assert events["check:lines"] == ("skipped", "Waiting for the supplier to be confirmed")
    assert events["check:budget"] == ("skipped", "Waiting for the supplier to be confirmed")
    # A person confirms the supplier; every check runs again and the printed order matches.
    vendor = next(v for v in detail["candidates"]["vendors"] if v["identifier"] == "ALDER-001")
    response = client.post(
        f"/invoices/{record[0]}/review",
        json={
            "expected_revision": 1,
            "vendor_id": vendor["id"],
            "reason": "Alder trades as Alder Office Supplies Inc.",
        },
    )
    assert response.status_code == 200, response.text
    with Session() as db:
        run_id = db.get(Invoice, record[0]).current_run
    pipeline.process(run_id)
    detail = client.get(f"/invoices/{record[0]}").json()
    assert detail["invoice"]["status"] == "APPROVED"
    assert detail["invoice"]["vendor_id"] == vendor["id"]
    final = [e for e in detail["events"] if e["run_id"] == run_id]
    po = [e for e in final if e["stage"] == "check:po"][-1]
    assert (po["state"], po["message"]) == (
        "passed",
        "PO-1042 · Workspace essentials · printed on the invoice",
    )
    assert [e for e in final if e["stage"] == "check:lines"][-1]["state"] == "passed"


SAMPLE_PACK = [
    "06-readable-scan.pdf",
    "07-multipage.pdf",
    "09-price-over.pdf",
    "10-missing-number.pdf",
    "11-foreign-currency.pdf",
    "12-ambiguous-date.pdf",
    "13-inclusive-tax.pdf",
    "14-closed-order.pdf",
    "15-injection.pdf",
    "18-heldout-discount.pdf",
    "20-heldout-credit.pdf",
]


def test_sample_pack_downloads_curated_invoices_with_a_readme(workspace):
    assert TestClient(app).get("/samples/pack").status_code == 401
    response = client_for(workspace).get("/samples/pack")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"] == (
        'attachment; filename="tickmark-sample-invoices.zip"'
    )
    with ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
        assert names == ["README.txt", *SAMPLE_PACK]
        readme = archive.read("README.txt").decode("utf-8")
        for name in SAMPLE_PACK:
            assert f"\n{name}\n  " in readme
            assert archive.read(name) == (Path("fixtures/pdfs") / name).read_bytes()
    assert "Juniper Labs" in readme and "Expected: blocked" in readme
    with Session() as db:
        assert db.get(Workspace, workspace[0]).uploads == 0
