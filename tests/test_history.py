"""Seeded history and inbox arrivals, decided by the real rules engine.

The first tests need only the generated fixtures. The integration tests seed a
real workspace in PostgreSQL and push every inbox invoice through the real
pipeline, with the model replaced by the fixture labels (no provider calls).
"""

import copy
import hashlib
import json
import os
import time
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest
from ap import history, pipeline
from ap.checks import GROUPS, reason_for
from ap.config import settings
from ap.db import Invoice, Session, Workspace
from ap.documents import read_document, verify_evidence
from ap.main import app
from ap.schemas import Extraction
from ap.seed import ITEM_ALIASES, ORDERS, VENDORS, seed_workspace
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text

HISTORY = Path("fixtures/history")
INBOX = Path("fixtures/inbox")


def requires_database(test):
    test = pytest.mark.integration(test)
    return pytest.mark.skipif(
        os.getenv("AP_INTEGRATION") != "1",
        reason="Set AP_INTEGRATION=1 with the dedicated PostgreSQL test database",
    )(test)


# The contract's history table: received (UTC), file, status, first reason, current reason.
CONTRACT = [
    ("2026-09-22T09:12", "alder-ald-1101.pdf", "APPROVED", None, None),
    ("2026-09-23T11:40", "coastline-cf-7712.pdf", "APPROVED", None, None),
    ("2026-09-24T14:05", "meridian-mer-2040.pdf", "APPROVED", None, None),
    ("2026-09-25T08:31", "brightwave-bw-0921.pdf", "APPROVED", None, None),
    ("2026-09-25T10:18", "fieldwork-fw-3051.pdf", "APPROVED", None, None),
    ("2026-09-26T15:52", "alder-ald-1159.pdf", "BLOCKED", "closed", "closed"),
    ("2026-09-26T16:47", "coastline-cf-7745.pdf", "APPROVED", None, None),
    ("2026-09-30T13:22", "meridian-mer-2055.pdf", "APPROVED", "nopo", None),
    ("2026-09-30T10:02", "pinecrest-pf-3301.pdf", "APPROVED", None, None),
    ("2026-10-02T12:15", "lumen-lp-5520.pdf", "APPROVED", None, None),
    ("2026-10-07T09:05", "alder-ald-1144.pdf", "APPROVED", None, None),
    ("2026-10-08T11:11", "harbor-hs-0412.pdf", "BLOCKED", "inactive", "inactive"),
    ("2026-10-09T14:44", "fieldwork-fw-3077.pdf", "APPROVED", None, None),
    ("2026-10-10T10:26", "coastline-cf-7768.pdf", "APPROVED", None, None),
    ("2026-10-13T09:58", "pinecrest-pf-3329.pdf", "APPROVED", "nopo", None),
    ("2026-10-14T15:31", "meridian-mer-2069.pdf", "APPROVED", None, None),
    ("2026-10-15T08:54", "coastline-cf-7781.pdf", "APPROVED", None, None),
    ("2026-10-16T13:09", "fieldwork-oct-16.pdf", "ON_HOLD", "nonumber", "nonumber"),
    ("2026-10-19T08:30", "brightwave-bw-1021.pdf", "APPROVED", None, None),
    ("2026-10-20T16:12", "lumen-lp-5538.pdf", "NEEDS_REVIEW", "budget", "budget"),
    ("2026-10-21T10:41", "coastline-cf-7790.pdf", "NEEDS_REVIEW", "price", "price"),
    ("2026-10-22T09:03", "brightwave-oct-resend.pdf", "BLOCKED", "duplicate", "duplicate"),
    ("2026-10-22T11:37", "meridian-mer-2077.pdf", "APPROVED", None, None),
    ("2026-10-23T14:20", "coastline-cf-7802.pdf", "APPROVED", None, None),
    ("2026-10-24T09:15", "pinecrest-pf-3342.pdf", "APPROVED", None, None),
    ("2026-10-26T16:02", "alder-ald-1201.pdf", "APPROVED", None, None),
]
REVIEWED = {"meridian-mer-2055.pdf": "PO-1091", "pinecrest-pf-3329.pdf": "PO-1131"}
BALANCES = {
    "PO-1038": "3800.00",
    "PO-1042": "4000.00",
    "PO-1088": "2400.00",
    "PO-1091": "5200.00",
    "PO-1103": "6600.00",
    "PO-1120": "3600.00",
    "PO-1124": "12000.00",
    "PO-1131": "1200.00",
    "PO-1135": "2400.00",
}
QUANTITIES_LEFT = {"PO-1042": "40", "PO-1120": "8"}


def test_history_fixtures_are_complete_and_grounded():
    items = history.dataset()
    assert [item["filename"] for item in items] == [row[1] for row in CONTRACT]
    for item, (received, *_) in zip(items, CONTRACT, strict=True):
        assert item["received_at"] == f"{received}:00+00:00"
        Extraction.model_validate(item["data"])
        pdf = (HISTORY / item["file"]).read_bytes()
        pages, _ = read_document(pdf)
        # Page data really is what the application's reader returns for the PDF.
        assert [p["text"] for p in pages] == [p["text"] for p in item["page_data"]]
        assert [len(p["words"]) for p in pages] == [len(p["words"]) for p in item["page_data"]]
        assert (HISTORY / item["page_images"][0]).read_bytes().startswith(b"\x89PNG")
        text_ = pages[0]["text"]
        assert "Juniper Labs" in text_ and "48 Foundry Street" in text_
        assert "Portland, OR 97209" in text_ and "Unit price" in text_
        evidence = verify_evidence(item["data"], pages)
        assert {e["status"] for e in evidence} == {"observed"}, item["file"]
        for citation in item["data"]["evidence"]:
            assert citation["quote"] in " ".join(w["text"] for w in pages[0]["words"])


def fake_registers():
    vendors = [
        SimpleNamespace(id=f"v:{ident}", name=name, identifier=ident, aliases=aliases, active=on)
        for name, ident, aliases, on in VENDORS
    ]
    orders = [
        SimpleNamespace(
            id=f"p:{ref}",
            vendor_id=f"v:{vendor}",
            reference=ref,
            description=description,
            ceiling=Decimal(ceiling),
            currency="USD",
            status=status,
            lines=[
                {
                    "sku": sku,
                    "description": item,
                    "aliases": [item, *ITEM_ALIASES.get(sku, [])],
                    "unit_price": price,
                    "quantity": quantity,
                    "unit": unit,
                }
            ],
        )
        for ref, vendor, description, ceiling, sku, item, price, quantity, unit, status in ORDERS
    ]
    return vendors, orders


def test_history_plan_matches_the_contract_without_a_database():
    vendors, orders = fake_registers()
    rows = history.Seeder("workspace", vendors, orders).build(history.dataset())
    decisions = {}
    for decision in rows["decision"]:
        decisions.setdefault(decision["invoice_id"], []).append(decision)
    by_file = {invoice["filename"]: invoice for invoice in rows["invoice"]}
    for _, filename, status, first_reason, reason in CONTRACT:
        invoice = by_file[filename]
        made = decisions[invoice["id"]]
        current = made[-1]
        assert (invoice["workflow"] or current["outcome"]) == status, filename
        assert reason_for(made[0]["checks"], made[0]["extraction"]) == first_reason, filename
        assert reason_for(current["checks"], current["extraction"]) == reason, filename
        assert len(made) == (2 if filename in REVIEWED else 1)
        assert invoice["human_touched"] is (filename in REVIEWED)
    used = {}
    for commitment in rows["commitment"]:
        used[commitment["po_id"]] = used.get(commitment["po_id"], 0) + commitment["amount"]
    for order in orders:
        if order.reference in BALANCES:
            remaining = order.ceiling - used.get(order.id, 0)
            assert f"{remaining:.2f}" == BALANCES[order.reference]


def test_inbox_fixtures_are_labelled_and_native_invoices_are_grounded():
    manifest = json.loads((INBOX / "manifest.json").read_text("utf-8"))["items"]
    labels = json.loads((INBOX / "labels.json").read_text("utf-8"))
    assert [(i["key"], i["time"]) for i in manifest] == [
        ("clean", "07:42"),
        ("tolerance", "08:05"),
        ("duplicate", "08:11"),
        ("budget", "08:26"),
        ("nopo", "08:48"),
        ("scan", "09:15"),
        ("assignment", "09:32"),
    ]
    for item in manifest:
        pdf = (INBOX / item["filename"]).read_bytes()
        if item["kind"] == "document":
            text_ = read_document(pdf)[0][0]["text"]
            assert "Invoice MER-2081 from supplier MERIDIAN-002" in text_
            assert "is assigned to PO-1088" in text_ and "PO-1091" not in text_
            continue
        label = labels[item["key"]]
        Extraction.model_validate(label["extraction"])
        if label["ocr"]:
            continue  # Image-only scan: OCR runs in the integration test below.
        pages, _ = read_document(pdf)
        assert "Juniper Labs" in pages[0]["text"]
        evidence = verify_evidence(label["extraction"], pages)
        assert {e["status"] for e in evidence} == {"observed"}, item["key"]


def test_sample_pack_behaves_in_a_seeded_workspace():
    from ap.rules import weak_identity
    from ap.samples import README, SAMPLES

    manifest = json.loads(Path("fixtures/manifest.json").read_text("utf-8"))
    corpus = {case["file"]: case for case in manifest["cases"]}
    labels = json.loads((INBOX / "labels.json").read_text("utf-8"))
    taken = {item["data"]["invoice_number"] for item in history.dataset()}
    taken |= {label["extraction"]["invoice_number"] for label in labels.values()}
    taken = {weak_identity(number) for number in taken if number}
    approvable = {}
    for name, description in SAMPLES:
        case = corpus[name]
        assert (Path("fixtures/pdfs") / name).is_file()
        assert f"{name}\n  {description}" in README
        # No sample can be taken for a duplicate of a seeded or inbox invoice.
        if case["number"]:
            assert case["number"] in description
            assert weak_identity(case["number"]) not in taken, name
        words = {"APPROVED": "approved", "NEEDS_REVIEW": "needs review", "BLOCKED": "blocked"}
        assert f"Expected: {words[case['expected']]}" in description, name
        if case["expected"] == "APPROVED":
            approvable[case["po"]] = approvable.get(case["po"], 0) + Decimal(case["total"])
    # Every sample expected to approve still fits what the seeded history leaves.
    for reference, total in approvable.items():
        assert total <= Decimal(BALANCES[reference]), reference


@pytest.fixture
def database_ready(monkeypatch):
    assert settings.database_url.endswith("/apdesk_test"), (
        "Integration tests require a separate apdesk_test database"
    )
    with Session.begin() as db:
        db.execute(text("UPDATE run SET state='FAILED' WHERE state IN ('QUEUED', 'RUNNING')"))
        db.execute(text("DELETE FROM quota"))
    monkeypatch.setattr(pipeline.assistant, "recommend", lambda *args: {"status": "unavailable"})


def client_for(workspace_id, token, csrf):
    client = TestClient(app)
    client.cookies.set("ap_session", token)
    client.headers.update({"origin": settings.origin, "x-csrf-token": csrf})
    return client


@pytest.fixture
def seeded(database_ready):
    history.dataset()  # loaded once per process, as the API does at startup
    started = time.perf_counter()
    with Session.begin() as db:
        workspace, token = seed_workspace(db, history=True)
        ids = workspace.id, token, workspace.csrf
    return (*ids, time.perf_counter() - started)


@requires_database
def test_new_workspace_opens_with_decided_history(seeded):
    workspace_id, token, csrf, seconds = seeded
    # Insert-only and batched: well under a second for the whole workspace.
    assert seconds < 1.0, f"Seeding took {seconds:.2f}s"
    client = client_for(workspace_id, token, csrf)
    queue = client.get("/invoices").json()
    rows = {row["filename"]: row for row in queue["invoices"]}
    assert len(rows) == len(CONTRACT)
    for received, filename, status, first_reason, reason in CONTRACT:
        row = rows[filename]
        assert row["status"] == status, (filename, row["summary"])
        assert row["first_reason_code"] == first_reason, filename
        assert row["reason_code"] == reason, filename
        assert row["source"] == "history"
        assert row["execution"] == "COMPLETED"
        assert row["created_at"] == f"{received}:00+00:00"
        assert row["revision"] == (2 if filename in REVIEWED else 1)
        assert row["human_touched"] is (filename in REVIEWED)
        assert row["invoice_date"] and row["due_date"]
    assert rows["brightwave-bw-0921.pdf"]["due_date"] == "2026-10-25"
    assert rows["brightwave-bw-0921.pdf"]["due_assumed"] is False
    assert rows["alder-ald-1101.pdf"]["due_date"] == "2026-10-22"
    assert rows["alder-ald-1101.pdf"]["due_assumed"] is True
    assert rows["brightwave-oct-resend.pdf"]["invoice_date"] == "2026-10-19"
    held = rows["fieldwork-oct-16.pdf"]
    assert (held["workflow"], held["workflow_to"], held["workflow_by"]) == (
        "ON_HOLD",
        "Fieldwork Equipment",
        "Prabhakar Kumar",
    )
    assert held["workflow_at"] == "2026-10-16T15:40:00+00:00"
    assert held["workflow_note"] == (
        "Asked Fieldwork for a corrected invoice that carries an invoice number."
    )
    assert held["reference"] is None and held["outcome"] == "NEEDS_REVIEW"

    orders = {o["reference"]: o for o in client.get("/purchase-orders").json()}
    for reference, remaining in BALANCES.items():
        assert orders[reference]["remaining"] == remaining, reference
    for reference, quantity in QUANTITIES_LEFT.items():
        assert orders[reference]["lines"][0]["remaining_quantity"] == quantity
    assert orders["PO-1042"]["committed"] == "6000.00"

    # The original of the re-sent invoice, by business identity.
    resend = client.get(f"/invoices/{rows['brightwave-oct-resend.pdf']['id']}").json()
    assert resend["decision"]["duplicate_id"] == rows["brightwave-bw-1021.pdf"]["id"]
    assert (resend["decision"]["reason_code"], resend["decision"]["reason"]) == (
        "duplicate",
        "Duplicate invoice",
    )
    resend_events = {e["stage"]: (e["state"], e["message"]) for e in resend["events"]}
    assert resend_events["check:duplicate"][0] == "blocked"
    # A blocked invoice reserves nothing, so no balance "after this invoice".
    assert resend_events["check:budget"] == (
        "skipped",
        "Nothing is reserved for a blocked invoice",
    )
    assert resend_events["read"] == ("passed", "Text layer found · no OCR needed")

    detail = client.get(f"/invoices/{rows['meridian-mer-2055.pdf']['id']}").json()
    assert [d["outcome"] for d in detail["history"]] == ["APPROVED", "NEEDS_REVIEW"]
    assert [(d["reason_code"], d["reason"]) for d in detail["history"]] == [
        (None, None),
        ("nopo", "No PO on the invoice"),
    ]
    lines = [(e["state"], e["message"]) for e in detail["events"] if e["stage"] == "check:lines"]
    # Before the order was chosen, lines were never shown as matching an order.
    assert lines[0] == ("skipped", "Waiting for a purchase order")
    assert lines[-1] == ("passed", "DESIGN-HR · 16 hours at $100.00, the order price")
    assert detail["decision"]["assistant"] == {"status": "imported"}
    assert detail["decision"]["comparison"]["po_reference"] == "PO-1091"
    review = next(a for a in detail["audit"] if a["action"] == "REVIEW")
    assert review["actor"] == "Priya Nair"
    assert review["at"] == "2026-09-30T16:05:00+00:00"
    assert review["after"] == {"purchase_order": "PO-1091"}
    assert review["reason"] == (
        "Product team confirmed the work belongs to the product studio order."
    )
    stages = [e["stage"] for e in detail["events"]]
    assert stages.count("decision") == 2 and "review" in stages
    for stage in ("intake", "read", "extract", *(f"check:{g}" for g in GROUPS)):
        assert stage in stages
    assert {e["status"] for e in detail["evidence"]} == {"observed"}
    assert all(e["bbox"] for e in detail["evidence"] if e["field"] != "vendor_name")

    hold = client.get(f"/invoices/{held['id']}").json()
    audit = next(a for a in hold["audit"] if a["action"] == "HOLD")
    assert (audit["actor"], audit["after"]["to"]) == ("Prabhakar Kumar", "Fieldwork Equipment")

    first = rows["alder-ald-1101.pdf"]
    item = history.dataset()[0]
    assert (
        client.get(f"/invoices/{first['id']}/source").content
        == (HISTORY / item["file"]).read_bytes()
    )
    page = client.get(f"/invoices/{first['id']}/pages/1")
    assert page.headers["content-type"] == "image/png"
    assert page.content == (HISTORY / item["page_images"][0]).read_bytes()
    assert client.get(f"/invoices/{first['id']}/pages/2").status_code == 404
    exported = client.get(f"/invoices/{first['id']}/export").json()
    assert exported["provenance"]["decisions"][0]["model"] == "imported"
    suppliers = {s["identifier"]: s for s in client.get("/suppliers").json()}
    assert suppliers["COAST-005"]["approved_value"] == "5400.00"
    assert suppliers["HARBOR-004"]["active"] is False
    with Session() as db:
        assert db.get(Workspace, workspace_id).uploads == 0
        assert (
            db.scalar(
                select(func.count())
                .select_from(Invoice)
                .where(Invoice.workspace_id == workspace_id)
            )
            == 26
        )
    # Seeded history is still ordinary workflow: the held invoice can be rejected.
    rejected = client.post(
        f"/invoices/{held['id']}/reject",
        json={"expected_revision": 1, "reason": "Fieldwork did not send a numbered invoice."},
    )
    assert rejected.status_code == 200, rejected.text


def labelled_extraction(monkeypatch):
    """Replace only the model: each inbox PDF reads as its fixture label."""
    manifest = json.loads((INBOX / "manifest.json").read_text("utf-8"))["items"]
    labels = json.loads((INBOX / "labels.json").read_text("utf-8"))
    by_digest = {
        hashlib.sha256((INBOX / item["filename"]).read_bytes()).hexdigest(): labels[item["key"]][
            "extraction"
        ]
        for item in manifest
        if item["kind"] == "invoice"
    }
    monkeypatch.setattr(
        pipeline.extraction,
        "extract",
        lambda document: (
            copy.deepcopy(by_digest[hashlib.sha256(document).hexdigest()]),
            {"model": "fixture-label", "usage": {}},
        ),
    )


def cites_assignment(data, result, sources, candidates):
    """Stand-in for the model: cite a retrieved company document that names the invoice."""
    for source in sources:
        if source["kind"] != "document" or data.get("invoice_number") not in source["text"]:
            continue
        order = next((c for c in candidates if c["reference"] in source["text"]), None)
        if order:
            return {
                "status": "ready",
                "explanation": "The project assignment names the order for this invoice.",
                "next_step": "Match the order and run the checks again.",
                "suggested_po_id": order["id"],
                "question": None,
                "draft_message": None,
                "sources": [
                    {k: v for k, v in source.items() if k != "text"} | {"quote": source["text"]}
                ],
            }
    return {"status": "unavailable"}


def check_and_process(client, key):
    response = client.post(f"/inbox/{key}/check")
    assert response.status_code == 200, response.text
    invoice_id = response.json()["id"]
    with Session() as db:
        run_id = db.get(Invoice, invoice_id).current_run
    pipeline.process(run_id)
    return client.get(f"/invoices/{invoice_id}").json()


@requires_database
def test_inbox_arrivals_reach_their_decisions_through_the_real_pipeline(seeded, monkeypatch):
    workspace_id, token, csrf, _ = seeded
    client = client_for(workspace_id, token, csrf)
    labelled_extraction(monkeypatch)
    monkeypatch.setattr(pipeline.assistant, "recommend", cites_assignment)
    expected = {
        "clean": ("APPROVED", None),
        "tolerance": ("APPROVED", None),
        "duplicate": ("BLOCKED", "duplicate"),
        "budget": ("NEEDS_REVIEW", "budget"),
        "nopo": ("NEEDS_REVIEW", "nopo"),
        "scan": ("NEEDS_REVIEW", "totals"),
    }
    decided = {}
    for key, (status, reason) in expected.items():
        detail = check_and_process(client, key)
        row = detail["invoice"]
        assert (row["status"], row["reason_code"]) == (status, reason), (key, row["summary"])
        assert row["source"] == "inbox"
        decided[key] = detail
    originals = {r["filename"]: r["id"] for r in client.get("/invoices").json()["invoices"]}
    assert decided["duplicate"]["decision"]["duplicate_id"] == originals["alder-ald-1201.pdf"]
    budget = {c["code"]: c for c in decided["budget"]["decision"]["checks"]}
    assert budget["budget"]["message"].startswith("Only $4,000.00 remains on this PO")
    assert "45 case billed; 40 remaining" in budget["quantity_PAPER-A4"]["message"]
    scan = {c["code"]: c for c in decided["scan"]["decision"]["checks"]}
    assert scan["arithmetic"]["message"].startswith("Calculated $900.00 / stated $990.00")
    assert decided["scan"]["run"]["state"] == "COMPLETED"

    def read(key):
        return [(e["state"], e["message"]) for e in decided[key]["events"] if e["stage"] == "read"]

    assert read("scan")[-1] == ("passed", "Scanned page · text recognised with OCR · 1 page")
    assert read("clean")[-1] == ("passed", "Text layer found · no OCR needed")
    duplicate = {e["stage"]: (e["state"], e["message"]) for e in decided["duplicate"]["events"]}
    assert duplicate["check:budget"] == ("skipped", "Nothing is reserved for a blocked invoice")
    tolerance = decided["tolerance"]["decision"]["comparison"]["lines"][0]
    assert (tolerance["invoice_price"], tolerance["po_price"]) == ("100.80", "100.00")
    assert tolerance["invoice_printed_price"] == tolerance["invoice_net_price"] == "100.80"
    nopo = decided["nopo"]["invoice"]
    assert nopo["po_reference"] is None
    assert len(decided["nopo"]["candidates"]["orders"]) == 2

    # The project assignment arrives and is saved; an AI review rechecks MER-2081.
    saved = client.post("/inbox/assignment/save")
    assert saved.status_code == 200
    document = saved.json()
    response = client.post(
        f"/invoices/{nopo['id']}/review",
        json={"expected_revision": 1, "reason": "Ask AI to check company documents."},
    )
    assert response.status_code == 200, response.text
    with Session() as db:
        run_id = db.get(Invoice, nopo["id"]).current_run
    pipeline.process(run_id)
    detail = client.get(f"/invoices/{nopo['id']}").json()
    assert detail["invoice"]["status"] == "APPROVED", detail["invoice"]["summary"]
    assert detail["decision"]["assistant"]["auto_matched"] is True
    assert detail["decision"]["comparison"]["po_reference"] == "PO-1088"
    assert detail["invoice"]["first_reason_code"] == "nopo"
    assert detail["decision"]["reason_code"] is None
    assert detail["history"][-1]["reason_code"] == "nopo"
    match = next(a for a in detail["audit"] if a["action"] == "AI_MATCH")
    assert (match["actor"], match["run_id"], match["revision"]) == ("AI assistant", run_id, 2)
    assert match["after"] == {
        "po_reference": "PO-1088",
        "document": "mer-2081-project-assignment.pdf",
        "document_id": document["id"],
    }
    assert match["reason"] == (
        "Matched PO-1088 from the company document 'mer-2081-project-assignment.pdf'."
    )
    assert not any(a["action"] == "AI_NO_MATCH" for a in detail["audit"])
    final = [e for e in detail["events"] if e["run_id"] == run_id]
    po_events = [e for e in final if e["stage"] == "check:po"]
    assert po_events[0]["state"] == "review"
    assert po_events[-1]["state"] == "passed"
    assert po_events[-1]["message"].endswith("matched from a company document")
    orders = {o["reference"]: o for o in client.get("/purchase-orders").json()}
    assert orders["PO-1088"]["remaining"] == "400.00"
    assert orders["PO-1120"]["remaining"] == "2700.00"
    assert orders["PO-1038"]["remaining"] == "2792.00"
    assert orders["PO-1042"]["remaining"] == "4000.00"
