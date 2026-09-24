"""PostgreSQL integration tests. Provider doubles exist only in this test module."""

import copy
import hashlib
import io
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
from pathlib import Path
from threading import Event as ThreadEvent
from zipfile import ZipFile

import pytest
from ap import pipeline
from ap.config import settings
from ap.db import (
    PO,
    Commitment,
    Decision,
    Invoice,
    Revision,
    Run,
    Session,
    Workspace,
    engine,
    now,
    uid,
)
from ap.main import app
from ap.seed import seed_workspace
from fastapi.testclient import TestClient
from sqlalchemy import event as sql_event
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("AP_INTEGRATION") != "1",
        reason="Set AP_INTEGRATION=1 with the dedicated PostgreSQL test database",
    ),
]


@pytest.fixture(autouse=True)
def dedicated_database(monkeypatch):
    assert settings.database_url.endswith("/apdesk_test"), (
        "Integration tests require a separate apdesk_test database"
    )
    # Previous test executions intentionally retain immutable records. Retire only
    # their unfinished jobs so the bounded dispatcher batch belongs to this test.
    with Session.begin() as db:
        db.execute(text("UPDATE run SET state='FAILED' WHERE state IN ('QUEUED', 'RUNNING')"))
    # These tests isolate financial transactions from the separately tested provider boundary.
    monkeypatch.setattr(pipeline.assistant, "recommend", lambda *args: {"status": "unavailable"})


@pytest.fixture
def workspace():
    with Session.begin() as db:
        w, token = seed_workspace(db)
        return w.id, token, w.csrf


def pages_and_citations(data):
    """Test-only independently addressable source observations."""
    words, citations = [], []
    pairs = [(k, v) for k, v in data.items() if isinstance(v, str)]
    pairs += [
        (f"lines.{i}.{k}", v)
        for i, line in enumerate(data["lines"])
        for k, v in line.items()
        if v is not None
    ]
    for y, (key, value) in enumerate(pairs):
        quote = f"{key}: {value}"
        citations.append({"field": key, "page": 1, "quote": quote, "raw": value})
        for x, word in enumerate(quote.split()):
            words.append(
                {
                    "text": word,
                    "x0": x * 50,
                    "x1": x * 50 + 45,
                    "top": y * 20,
                    "bottom": y * 20 + 12,
                }
            )
    data["evidence"] = citations
    return [
        {
            "page": 1,
            "width": 612,
            "height": 792,
            "method": "native",
            "text": " ".join(w["text"] for w in words),
            "words": words,
        }
    ]


def pending(workspace_id, facts, quantity="12", reference=None):
    facts = copy.deepcopy(facts)
    facts["invoice_number"] = reference or "TEST-" + uid()[:8]
    facts["lines"][0]["quantity"] = quantity
    facts["subtotal"] = facts["total"] = facts["lines"][0]["total"] = str(Decimal(quantity) * 100)
    pages = pages_and_citations(facts)
    with Session.begin() as db:
        invoice = Invoice(
            workspace_id=workspace_id,
            filename="test.pdf",
            sha256=hashlib.sha256(uid().encode()).hexdigest(),
            object_key="test",
        )
        db.add(invoice)
        db.flush()
        token = uid()
        run = Run(
            invoice_id=invoice.id,
            revision=1,
            state="RUNNING",
            attempt=1,
            attempt_token=token,
            started_at=now(),
            lease_until=now() + timedelta(minutes=5),
        )
        db.add(run)
        db.flush()
        invoice.current_run = run.id
        db.add(Revision(invoice_id=invoice.id, number=1))
        return invoice.id, run.id, token, facts, pages


def finish(record):
    invoice_id, run_id, token, facts, pages = record
    pipeline.finalize(run_id, token, facts, pages, {"model": "isolated-test-double", "usage": {}})
    with Session() as db:
        return db.scalar(select(Decision).where(Decision.run_id == run_id)).outcome


def test_concurrent_po_spend_and_quantities(workspace, facts):
    records = [pending(workspace[0], facts, "25") for _ in range(2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(finish, records))
    assert sorted(outcomes) == ["APPROVED", "NEEDS_REVIEW"]
    with Session() as db:
        assert db.scalar(
            select(func.sum(Commitment.amount)).where(Commitment.workspace_id == workspace[0])
        ) == Decimal("8500")


def test_delivery_and_finalization_idempotency(workspace, facts):
    record = pending(workspace[0], facts)
    assert finish(record) == "APPROVED"
    assert finish(record) == "APPROVED"
    pipeline.process(record[1])
    with Session() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(Commitment)
                .where(Commitment.invoice_id == record[0])
            )
            == 1
        )
        assert (
            db.scalar(
                select(func.count()).select_from(Decision).where(Decision.invoice_id == record[0])
            )
            == 1
        )


def test_business_identity_concurrent(workspace, facts):
    records = [pending(workspace[0], facts, "10", "SAME-001") for _ in range(2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(finish, records))
    assert sorted(outcomes) == ["APPROVED", "BLOCKED"]


def test_old_attempt_and_revision_cannot_write(workspace, facts):
    record = pending(workspace[0], facts)
    with Session.begin() as db:
        db.get(Run, record[1]).attempt_token = "new-token"
    pipeline.finalize(record[1], record[2], record[3], record[4], {"model": "test"})
    with Session() as db:
        assert (
            db.scalar(
                select(func.count()).select_from(Decision).where(Decision.invoice_id == record[0])
            )
            == 0
        )
    with Session.begin() as db:
        db.get(Run, record[1]).attempt_token = record[2]
        db.get(Invoice, record[0]).revision = 2
    pipeline.finalize(record[1], record[2], record[3], record[4], {"model": "test"})
    with Session() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(Commitment)
                .where(Commitment.invoice_id == record[0])
            )
            == 0
        )


def test_revision_is_refreshed_after_waiting_for_lock(workspace, facts):
    record = pending(workspace[0], facts)
    waiting = ThreadEvent()

    def before_cursor(connection, cursor, statement, parameters, context, many):
        if "FROM workspace" in statement and "FOR UPDATE" in statement:
            waiting.set()

    with ThreadPoolExecutor(max_workers=1) as pool, Session.begin() as db:
        db.execute(select(Workspace).where(Workspace.id == workspace[0]).with_for_update())
        sql_event.listen(engine, "before_cursor_execute", before_cursor)
        future = pool.submit(
            pipeline.finalize,
            record[1],
            record[2],
            record[3],
            record[4],
            {"model": "isolated-test-double"},
        )
        try:
            assert waiting.wait(10)
            invoice = db.get(Invoice, record[0])
            invoice.revision = 2
            db.get(Run, record[1]).attempt_token = "newer-worker-token"
            db.commit()
            future.result(timeout=10)
        finally:
            sql_event.remove(engine, "before_cursor_execute", before_cursor)
    with Session() as db:
        assert (
            db.scalar(
                select(func.count()).select_from(Decision).where(Decision.invoice_id == record[0])
            )
            == 0
        )


def test_database_budget_guard(workspace):
    with Session() as db:
        po = db.scalar(select(PO).where(PO.workspace_id == workspace[0], PO.reference == "PO-1042"))
        data = dict(
            workspace_id=workspace[0],
            po_id=po.id,
            vendor_id=po.vendor_id,
            identity="DB-GUARD",
            currency="USD",
            invoice_date="2026-09-15",
            quantities={"PAPER-A4": "1"},
        )
    with pytest.raises(DBAPIError), Session.begin() as db:
        db.add(Commitment(**data, amount=Decimal("4000.01")))
        db.flush()


def test_database_quantity_guard(workspace):
    with Session() as db:
        po = db.scalar(select(PO).where(PO.workspace_id == workspace[0], PO.reference == "PO-1042"))
    with pytest.raises(DBAPIError), Session.begin() as db:
        db.add(
            Commitment(
                workspace_id=workspace[0],
                po_id=po.id,
                vendor_id=po.vendor_id,
                identity="Q-GUARD",
                currency="USD",
                invoice_date="2026-09-15",
                quantities={"PAPER-A4": "41"},
                amount=Decimal("1"),
            )
        )
        db.flush()


def test_history_immutable(workspace, facts):
    record = pending(workspace[0], facts)
    finish(record)
    with pytest.raises(DBAPIError), Session.begin() as db:
        db.execute(
            text("UPDATE decision SET summary='rewritten' WHERE invoice_id=:id"), {"id": record[0]}
        )


def client_for(workspace):
    client = TestClient(app)
    client.cookies.set("ap_session", workspace[1])
    client.headers.update({"origin": settings.origin, "x-csrf-token": workspace[2]})
    return client


def test_named_profile_invitation_roles_revocation_and_single_use(workspace):
    owner = client_for(workspace)
    profile = owner.post("/profile", json={"name": "Maya Patel", "email": "maya@example.com"})
    assert profile.status_code == 200
    assert owner.get("/session").json()["user"]["name"] == "Maya Patel"
    assert (
        owner.post(
            "/company", json={"name": "Juniper Studio", "address": "", "ai_assistance": True}
        ).status_code
        == 200
    )
    invitation = owner.post(
        "/team/invitations", json={"email": "alex@example.com", "role": "viewer"}
    )
    assert invitation.status_code == 201
    token = invitation.json()["url"].split("#token=")[1]
    viewer = TestClient(app, headers={"origin": settings.origin})
    assert (
        viewer.post("/invitations/preview", json={"token": token}).json()["company"]
        == "Juniper Studio"
    )
    joined = viewer.post("/invitations/accept", json={"token": token, "name": "Alex Rivera"})
    assert joined.status_code == 200
    viewer.headers["x-csrf-token"] = joined.json()["csrf"]
    assert joined.json()["workspace"] == workspace[0][:8]
    assert viewer.get("/suppliers").status_code == 200
    assert viewer.post("/company", json={"name": "Other"}).status_code == 403
    assert viewer.post("/team/invitations", json={"email": "third@example.com"}).status_code == 403
    assert (
        viewer.post(
            "/documents", files={"file": ("bad.pdf", b"fake", "application/pdf")}
        ).status_code
        == 403
    )
    assert (
        viewer.post(
            "/invoices", files={"file": ("bad.pdf", b"fake", "application/pdf")}
        ).status_code
        == 403
    )
    assert (
        viewer.post("/invitations/accept", json={"token": token, "name": "Again"}).status_code
        == 410
    )
    assert owner.delete(f"/team/members/{joined.json()['user']['id']}").status_code == 204
    assert viewer.get("/session").status_code == 401
    another = owner.post("/team/invitations", json={"email": "jamie@example.com"}).json()
    assert owner.delete(f"/team/invitations/{another['id']}").status_code == 204
    assert (
        viewer.post(
            "/invitations/accept",
            json={"token": another["url"].split("#token=")[1], "name": "Jamie Lee"},
        ).status_code
        == 410
    )


def test_reference_documents_are_scoped_deduplicated_previewable_and_archivable(workspace):
    from ap import assistant
    from ap.db import CompanyDocument

    client = client_for(workspace)
    pdf = Path("fixtures/pdfs/01-clean.pdf").read_bytes()
    document = client.post(
        "/documents", files={"file": ("supplier-reference.pdf", pdf, "application/pdf")}
    )
    assert document.status_code == 201, document.text
    document_id = document.json()["id"]
    assert (
        client.post("/documents", files={"file": ("same.pdf", pdf, "application/pdf")}).json()["id"]
        == document_id
    )
    assert client.get(f"/documents/{document_id}/source").content == pdf
    assert client.get(f"/documents/{document_id}/pages/1").content.startswith(b"\x89PNG")
    with Session.begin() as db:
        other, token = seed_workspace(db)
    stranger = client_for((other.id, token, other.csrf))
    assert stranger.get("/documents").json() == []
    for suffix in ("source", "pages/1"):
        assert stranger.get(f"/documents/{document_id}/{suffix}").status_code == 404
    assert stranger.delete(f"/documents/{document_id}").status_code == 404
    with Session() as db:
        own_sources, _ = assistant.retrieve(
            db, workspace[0], {"vendor_identifier": "ALDER-001"}, [], [], []
        )
        other_sources, _ = assistant.retrieve(
            db, other.id, {"vendor_identifier": "ALDER-001"}, [], [], []
        )
    assert any(s.get("document_id") == document_id for s in own_sources)
    assert not any(s.get("document_id") == document_id for s in other_sources)
    assert client.delete(f"/documents/{document_id}").status_code == 204
    assert client.get("/documents").json() == []
    with Session() as db:
        assert db.get(CompanyDocument, document_id).archived
        sources, _ = assistant.retrieve(
            db, workspace[0], {"vendor_identifier": "ALDER-001"}, [], [], []
        )
        assert not any(s.get("document_id") == document_id for s in sources)


def test_ai_supported_po_still_obeys_current_budget(workspace, facts):
    from ap.db import CompanyDocument

    record = pending(workspace[0], facts, "45", reference="AI-OVER-LIMIT")
    invoice_id, run_id, token, data, _ = record
    data["po_reference"], data["po_references"] = None, []
    pages = pages_and_citations(data)
    quote = "Invoice AI-OVER-LIMIT for supplier ALDER-001 is assigned to PO-1042."
    with Session.begin() as db:
        po = db.scalar(select(PO).where(PO.workspace_id == workspace[0], PO.reference == "PO-1042"))
        doc = CompanyDocument(
            workspace_id=workspace[0],
            filename="assignment.pdf",
            object_key="test",
            sha256=uid(),
            page_data=[{"page": 1, "text": quote}],
            uploaded_by="Maya Patel",
        )
        db.add(doc)
        db.flush()
        assistance = {
            "status": "ready",
            "suggested_po_id": po.id,
            "sources": [{"kind": "document", "document_id": doc.id, "quote": quote}],
        }
    pipeline.finalize(
        run_id,
        token,
        data,
        pages,
        {"model": "test", "assistant": assistance, "assistant_outcome": "NEEDS_REVIEW"},
    )
    with Session() as db:
        decision = db.scalar(select(Decision).where(Decision.run_id == run_id))
        assert decision.assistant["auto_matched"] is True
        assert decision.outcome == "NEEDS_REVIEW"
        assert decision.po_id == po.id
        assert db.scalar(select(Commitment.id).where(Commitment.invoice_id == invoice_id)) is None


def test_ai_provider_failure_keeps_automatic_checks_available(workspace, facts, monkeypatch):
    record = pending(workspace[0], facts)

    def unavailable(*args):
        raise TimeoutError("test-only provider timeout")

    monkeypatch.setattr(pipeline.assistant, "recommend", unavailable)
    metadata = pipeline.prepare_assistance(
        workspace[0], record[0], record[3], record[4], {}, record[1], record[2]
    )
    assert metadata["assistant"]["status"] == "unavailable"
    pipeline.finalize(record[1], record[2], record[3], record[4], {"model": "test", **metadata})
    with Session() as db:
        decision = db.scalar(select(Decision).where(Decision.run_id == record[1]))
        assert decision.outcome == "APPROVED"
        assert decision.assistant["status"] == "unavailable"


@pytest.mark.parametrize("guidance", ["missing", "null", "provided"])
def test_missing_po_has_a_follow_up_request_even_with_one_candidate(workspace, facts, guidance):
    record = pending(workspace[0], facts, "2", reference="FW-2204")
    invoice_id, run_id, token, data, _ = record
    data.update(
        vendor_name="Fieldwork Equipment",
        vendor_identifier="FIELD-003",
        po_reference=None,
        po_references=[],
        subtotal="600.00",
        total="600.00",
    )
    data["lines"][0].update(
        description="27 inch monitor",
        sku="MONITOR-27",
        quantity="2",
        unit="unit",
        unit_price="300.00",
        total="600.00",
    )
    pages = pages_and_citations(data)
    with Session() as db:
        vendors, orders, _, _ = pipeline.financial_context(db, workspace[0], invoice_id, lock=False)
    vendor = next(v for v in vendors if v["identifier"] == "FIELD-003")
    candidates = [p for p in orders if p["vendor_id"] == vendor["id"] and p["status"] == "ACTIVE"]
    assert len(candidates) == 1
    assistance = {
        "status": "ready",
        "explanation": "The invoice is missing a purchase order reference.",
        "next_step": "Obtain the supporting assignment.",
        "sources": [{"kind": "invoice", "page": 1, "quote": "invoice_number: FW-2204"}],
    }
    if guidance == "null":
        assistance.update(question=None, draft_message=None)
    elif guidance == "provided":
        assistance.update(
            question="Can procurement confirm the order assigned to this invoice?",
            draft_message="Please share the purchase order assignment for FW-2204.",
        )
    pipeline.finalize(
        run_id,
        token,
        data,
        pages,
        {
            "model": "isolated-test-double",
            "assistant": assistance,
            "assistant_outcome": "NEEDS_REVIEW",
        },
    )
    with Session() as db:
        decision = db.scalar(select(Decision).where(Decision.run_id == run_id))
        assert decision.outcome == "NEEDS_REVIEW"
        assert decision.po_id is None
        assert not decision.assistant.get("auto_matched")
        assert db.scalar(select(Commitment.id).where(Commitment.invoice_id == invoice_id)) is None
        assert decision.assistant["explanation"] == assistance["explanation"]
        assert decision.assistant["next_step"] == assistance["next_step"]
        assert decision.assistant["sources"] == assistance["sources"]
        if guidance == "provided":
            assert decision.assistant["question"] == assistance["question"]
            assert decision.assistant["draft_message"] == assistance["draft_message"]
            assert "draft_origin" not in decision.assistant
        else:
            assert decision.assistant["draft_origin"] == "policy_template"
            for field in ("question", "draft_message"):
                assert "FW-2204" in decision.assistant[field]
                assert "FIELD-003" in decision.assistant[field]
                assert "PO-1103" not in decision.assistant[field]
            assert "procurement confirmation" in decision.assistant["draft_message"]


def test_demo_preview_and_pack_are_session_scoped_read_only(workspace):
    client = client_for(workspace)
    anonymous = TestClient(app)
    for route in (
        "/scenarios",
        "/scenarios/pack",
        "/scenarios/clean/pdf",
        "/scenarios/clean/preview",
    ):
        assert anonymous.get(route).status_code == 401
    samples = client.get("/scenarios").json()
    expected_files = {s["file"] for s in samples}
    pack = client.get("/scenarios/pack")
    assert pack.status_code == 200
    assert pack.headers["content-type"] == "application/zip"
    with ZipFile(io.BytesIO(pack.content)) as archive:
        assert set(archive.namelist()) == expected_files | {"START-HERE.txt"}
        assert "PO-1088" in archive.read("START-HERE.txt").decode()
        for sample in samples:
            source = Path("fixtures/pdfs") / sample["file"]
            original = client.get(f"/scenarios/{sample['id']}/pdf")
            assert original.content == archive.read(sample["file"]) == source.read_bytes()
            preview = client.get(f"/scenarios/{sample['id']}/preview")
            assert preview.status_code == 200
            assert preview.headers["content-type"] == "image/png"
            assert preview.content.startswith(b"\x89PNG")
            assert preview.content == source.with_suffix(".preview.png").read_bytes()
    assert client.get("/scenarios/not-a-sample/preview").status_code == 404
    assert client.get("/scenarios/not-a-sample/pdf").status_code == 404
    assert client.get("/invoices").json()["invoices"] == []
    with Session() as db:
        assert db.get(Workspace, workspace[0]).uploads == 0


FOLLOW_UP_CASES = [
    ("brand-assignment", "MER-2201", "MERIDIAN-002", "PO-1088", "8", "800", "APPROVED"),
    ("product-confirmation", "MER-2202", "MERIDIAN-002", "PO-1091", "12", "1200", "APPROVED"),
    ("office-delivery", "ALD-2203", "ALDER-001", "PO-1038", "6", "600", "APPROVED"),
    ("equipment-receipt", "FW-2204", "FIELD-003", "PO-1103", "2", "600", "APPROVED"),
    ("budget-shortfall", "ALD-2205", "ALDER-001", "PO-1042", "45", "4500", "NEEDS_REVIEW"),
]


def test_follow_up_examples_and_paired_pack_are_protected_and_read_only(workspace):
    import pdfplumber
    from ap.db import CompanyDocument

    client, anonymous = client_for(workspace), TestClient(app)
    routes = ["/follow-up-examples", "/follow-up-examples/pack"]
    routes += [
        f"/follow-up-examples/brand-assignment/{part}{suffix}"
        for part in ("invoice", "reference")
        for suffix in ("", "/preview")
    ]
    for route in routes:
        assert anonymous.get(route).status_code == 401
    response = client.get("/follow-up-examples")
    assert response.status_code == 200
    samples = response.json()
    assert {sample["id"] for sample in samples} == {case[0] for case in FOLLOW_UP_CASES}
    expected_cases = {case[0]: case for case in FOLLOW_UP_CASES}
    expected_files = {sample[key] for sample in samples for key in ("file", "reference_file")}
    assert len(expected_files) == 10
    pack = client.get("/follow-up-examples/pack")
    assert pack.status_code == 200
    assert pack.headers["content-type"] == "application/zip"
    with ZipFile(io.BytesIO(pack.content)) as archive:
        assert set(archive.namelist()) == expected_files | {"START-HERE.txt"}
        instructions = archive.read("START-HERE.txt").decode()
        for sample in samples:
            _, invoice_number, vendor_id, po_reference, _, _, _ = expected_cases[sample["id"]]
            assert sample["invoice_number"] == invoice_number
            assert sample["expected_before"] == "Review required"
            assert sample["file"] in instructions
            assert sample["reference_file"] in instructions
            for part, file_key in (("invoice", "file"), ("reference", "reference_file")):
                source = Path("fixtures/pdfs") / sample[file_key]
                route = f"/follow-up-examples/{sample['id']}/{part}"
                original = client.get(route)
                assert original.status_code == 200
                assert original.headers["content-type"] == "application/pdf"
                assert original.content == source.read_bytes() == archive.read(sample[file_key])
                with pdfplumber.open(io.BytesIO(original.content)) as pdf:
                    text = " ".join(page.extract_text() or "" for page in pdf.pages)
                assert invoice_number in text
                assert vendor_id in text
                assert "synthetic" in text.lower()
                if part == "reference":
                    assert po_reference in text
                else:
                    assert po_reference not in text
                preview = client.get(f"{route}/preview")
                assert preview.status_code == 200
                assert preview.headers["content-type"] == "image/png"
                assert preview.content.startswith(b"\x89PNG")
                assert preview.content == source.with_suffix(".preview.png").read_bytes()
    for part in ("invoice", "reference"):
        for suffix in ("", "/preview"):
            assert (
                client.get(f"/follow-up-examples/not-an-example/{part}{suffix}").status_code == 404
            )
    assert client.get("/invoices").json()["invoices"] == []
    assert client.get("/documents").json() == []
    with Session() as db:
        assert db.get(Workspace, workspace[0]).uploads == 0
        assert not db.scalar(
            select(CompanyDocument.id).where(CompanyDocument.workspace_id == workspace[0])
        )


@pytest.mark.parametrize(
    "case_id,invoice_number,vendor_identifier,po_reference,quantity,amount,expected",
    FOLLOW_UP_CASES,
    ids=[case[0] for case in FOLLOW_UP_CASES],
)
def test_follow_up_evidence_matches_po_but_retains_financial_gates(
    workspace,
    facts,
    case_id,
    invoice_number,
    vendor_identifier,
    po_reference,
    quantity,
    amount,
    expected,
):
    from ap import assistant
    from ap.rules import evaluate

    client = client_for(workspace)
    record = pending(workspace[0], facts, quantity, reference=invoice_number)
    invoice_id, run_id, token, data, _ = record
    with Session() as db:
        context = pipeline.financial_context(db, workspace[0], invoice_id, lock=False)
    vendors, orders = context[:2]
    vendor = next(v for v in vendors if v["identifier"] == vendor_identifier)
    po = next(p for p in orders if p["reference"] == po_reference)
    line = po["lines"][0]
    data.update(
        vendor_name=vendor["name"],
        vendor_identifier=vendor_identifier,
        po_reference=None,
        po_references=[],
        subtotal=amount,
        total=amount,
    )
    data["lines"][0].update(
        description=line["description"],
        sku=line["sku"],
        unit=line["unit"],
        unit_price=line["unit_price"],
        quantity=quantity,
        total=amount,
    )
    pages = pages_and_citations(data)
    evidence = pipeline.verify_evidence(data, pages)
    initial = evaluate(data, evidence, *context, {}, now().date())
    assert initial["outcome"] == "NEEDS_REVIEW"
    assert initial["po_id"] is None

    reference = client.get(f"/follow-up-examples/{case_id}/reference")
    assert reference.status_code == 200
    uploaded = client.post(
        "/documents",
        files={"file": (f"{case_id}-confirmation.pdf", reference.content, "application/pdf")},
    )
    assert uploaded.status_code == 201, uploaded.text
    document_id = uploaded.json()["id"]
    with Session() as db:
        sources, _ = assistant.retrieve(db, workspace[0], data, pages, vendors, orders)
    source = next(
        s
        for s in sources
        if s.get("document_id") == document_id
        and invoice_number in s["text"]
        and po_reference in s["text"]
    )
    assistance = {
        "status": "ready",
        "suggested_po_id": po["id"],
        "sources": [{k: v for k, v in source.items() if k != "text"} | {"quote": source["text"]}],
        "explanation": "The invoice should be matched and approved.",
        "next_step": "Approve this invoice after matching the order.",
        "question": "Which purchase order should be used?",
        "draft_message": "Please confirm the order so this invoice can be approved.",
    }
    pipeline.finalize(
        run_id,
        token,
        data,
        pages,
        {
            "model": "isolated-test-double",
            "assistant": assistance,
            "assistant_outcome": initial["outcome"],
        },
    )
    with Session() as db:
        decision = db.scalar(select(Decision).where(Decision.run_id == run_id))
        assert decision.assistant["auto_matched"] is True
        assert decision.po_id == po["id"]
        assert decision.outcome == expected, decision.checks
        assert decision.assistant["explanation"] == (
            "A supported purchase-order match was applied. " + decision.summary
        )
        assert decision.assistant["next_step"] == decision.next_action
        assert decision.assistant["question"] is None
        assert decision.assistant["draft_message"] is None
        assert decision.assistant["sources"] == assistance["sources"]
        commitment = db.scalar(select(Commitment).where(Commitment.invoice_id == invoice_id))
        if expected == "APPROVED":
            assert commitment.amount == Decimal(amount)
            assert commitment.quantities == {line["sku"]: quantity}
        else:
            # Review remains review, but a resolved PO must not leave the earlier
            # optimistic approval advice or missing-PO question on the screen.
            assert initial["outcome"] == decision.outcome
            assert commitment is None
            assert decision.comparison["remaining_before"] == "4000.00"
            assert decision.comparison["shortfall"] == "500.00"
            checks = {check["code"]: check for check in decision.checks}
            assert checks["budget"]["state"] == "review"
            assert checks["quantity_PAPER-A4"]["state"] == "review"
            assert "45 case billed; 40 remaining" in checks["quantity_PAPER-A4"]["message"]


def test_follow_up_reference_cannot_match_another_invoice_from_the_same_supplier(workspace):
    import pdfplumber
    from ap import assistant

    client = client_for(workspace)
    active_documents = {}
    for case in FOLLOW_UP_CASES:
        response = client.get(f"/follow-up-examples/{case[0]}/reference")
        assert response.status_code == 200
        with pdfplumber.open(io.BytesIO(response.content)) as pdf:
            active_documents[case[0]] = [
                {"page": i + 1, "text": page.extract_text() or ""}
                for i, page in enumerate(pdf.pages)
            ]
    with Session() as db:
        vendors, orders, _, _ = pipeline.financial_context(db, workspace[0], uid(), lock=False)
    for case_id, invoice_number, vendor_id, po_reference, _, _, _ in FOLLOW_UP_CASES:
        po = next(p for p in orders if p["reference"] == po_reference)
        quote = " ".join(page["text"] for page in active_documents[case_id])
        assistance = {
            "status": "ready",
            "suggested_po_id": po["id"],
            "sources": [{"kind": "document", "document_id": case_id, "quote": quote}],
        }
        data = {"invoice_number": invoice_number, "vendor_identifier": vendor_id, "currency": "USD"}
        assert (
            assistant.grounded_po(data, {}, assistance, vendors, orders, active_documents)
            == po["id"]
        )
        for other in FOLLOW_UP_CASES:
            if other[2] == vendor_id and other[1] != invoice_number:
                wrong_invoice = {**data, "invoice_number": other[1]}
                assert (
                    assistant.grounded_po(
                        wrong_invoice, {}, assistance, vendors, orders, active_documents
                    )
                    is None
                )


def test_upload_validation_same_file_and_private_sources(workspace):
    client = client_for(workspace)
    assert (
        client.post(
            "/invoices", files={"file": ("bad.pdf", b"not pdf", "application/pdf")}
        ).status_code
        == 422
    )
    data = Path("fixtures/pdfs/01-clean.pdf").read_bytes()
    first = client.post("/invoices", files={"file": ("invoice.pdf", data, "application/pdf")})
    assert first.status_code == 201, first.text
    second = client.post("/invoices", files={"file": ("copy.pdf", data, "application/pdf")})
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["existing"] is True
    with Session.begin() as db:
        other, token = seed_workspace(db)
    stranger = client_for((other.id, token, other.csrf))
    invoice_id = first.json()["id"]
    for route in [
        f"/invoices/{invoice_id}",
        f"/invoices/{invoice_id}/source",
        f"/invoices/{invoice_id}/pages/1",
        f"/invoices/{invoice_id}/export",
        f"/invoices/{invoice_id}/events",
    ]:
        assert stranger.get(route).status_code == 404
    assert (
        stranger.post(f"/invoices/{invoice_id}/retry", json={"expected_revision": 1}).status_code
        == 404
    )
    assert client.get(f"/invoices/{invoice_id}/source").content == data


def test_origin_csrf_expiry(workspace):
    client = client_for(workspace)
    assert client.post("/session", headers={"origin": "https://wrong.example"}).status_code == 403
    data = Path("fixtures/pdfs/01-clean.pdf").read_bytes()
    assert (
        client.post(
            "/invoices",
            files={"file": ("a.pdf", data, "application/pdf")},
            headers={"x-csrf-token": "wrong"},
        ).status_code
        == 403
    )
    with Session.begin() as db:
        db.get(Workspace, workspace[0]).expires_at = now() - timedelta(seconds=1)
    assert client.get("/invoices").status_code == 401


def test_review_loop_and_stale_edit(workspace, facts):
    record = pending(workspace[0], facts)
    record[3]["po_reference"] = None
    assert finish(record) == "NEEDS_REVIEW"
    client = client_for(workspace)
    detail = client.get(f"/invoices/{record[0]}")
    assert detail.status_code == 200, detail.text
    po = detail.json()["candidates"]["orders"][0]
    payload = {
        "expected_revision": 1,
        "po_id": po["id"],
        "reason": "Confirmed against the procurement work order.",
    }
    assert client.post(f"/invoices/{record[0]}/review", json=payload).status_code == 200
    assert client.post(f"/invoices/{record[0]}/review", json=payload).status_code == 409
    with Session() as db:
        invoice = db.get(Invoice, record[0])
        new_run = invoice.current_run
    pipeline.process(new_run)
    current = client.get(f"/invoices/{record[0]}").json()
    assert current["invoice"]["outcome"] == "APPROVED", current
    assert len(current["history"]) == 2
    assert current["invoice"]["human_touched"] is True
    assert (
        client.post(
            f"/invoices/{record[0]}/review", json={**payload, "expected_revision": 2}
        ).status_code
        == 409
    )
    assert client.get(f"/invoices/{record[0]}/export").json()["provenance"]["document_sha256"]


def test_no_failure_decision_and_retry_bound(workspace, facts, monkeypatch):
    record = pending(workspace[0], facts)
    with Session.begin() as db:
        run = db.get(Run, record[1])
        run.state, run.attempt, run.lease_until = "QUEUED", 0, None
        invoice = db.get(Invoice, record[0])
        invoice.page_data = record[4]
    monkeypatch.setattr(pipeline.storage, "get", lambda _: b"isolated test double")
    monkeypatch.setattr(
        pipeline.extraction,
        "extract",
        lambda _: (_ for _ in ()).throw(
            pipeline.extraction.ExtractionFailure("Test provider unavailable")
        ),
    )
    pipeline.process(record[1])
    with Session() as db:
        assert db.get(Run, record[1]).state == "FAILED"
        assert db.get(Invoice, record[0]).current_decision is None
        assert (
            db.scalar(
                select(func.count())
                .select_from(Commitment)
                .where(Commitment.invoice_id == record[0])
            )
            == 0
        )


def test_dispatch_failure_is_recoverable(workspace, facts, monkeypatch):
    from ap import dispatcher

    record = pending(workspace[0], facts)
    with Session.begin() as db:
        r = db.get(Run, record[1])
        r.state, r.attempt, r.lease_until = "QUEUED", 0, None

    def fail(*args, **kwargs):
        raise ConnectionError("isolated broker outage")

    monkeypatch.setattr(dispatcher.process_invoice, "apply_async", fail)
    dispatcher.dispatch_once()
    with Session() as db:
        assert db.get(Run, record[1]).state == "QUEUED"
        assert db.get(Run, record[1]).dispatched_at is None
    sent = []
    monkeypatch.setattr(
        dispatcher.process_invoice, "apply_async", lambda **kw: sent.append(kw["args"][0])
    )
    dispatcher.dispatch_once()
    assert record[1] in sent


def test_transient_provider_retry_is_bounded(workspace, facts, monkeypatch):
    import httpx
    from openai import APIConnectionError

    record = pending(workspace[0], facts)
    with Session.begin() as db:
        run = db.get(Run, record[1])
        run.state, run.attempt, run.lease_until = "QUEUED", 0, None
        db.get(Invoice, record[0]).page_data = record[4]
    calls = []

    def unavailable(_):
        calls.append(1)
        raise APIConnectionError(request=httpx.Request("POST", "https://provider.invalid"))

    monkeypatch.setattr(pipeline.storage, "get", lambda _: b"test provider input")
    monkeypatch.setattr(pipeline.extraction, "extract", unavailable)
    for attempt in range(1, 4):
        pipeline.process(record[1])
        with Session.begin() as db:
            run = db.get(Run, record[1])
            assert run.attempt == attempt
            assert run.state == ("QUEUED" if attempt < 3 else "FAILED")
            assert db.get(Invoice, record[0]).current_decision is None
            if attempt < 3:
                assert run.retry_at > now()
                run.retry_at = now() - timedelta(seconds=1)
    pipeline.process(record[1])
    assert len(calls) == 3
    with Session() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(Commitment)
                .where(Commitment.invoice_id == record[0])
            )
            == 0
        )


def test_expired_worker_lease_recovers_without_duplicate_commitment(workspace, facts, monkeypatch):
    from ap import dispatcher

    record = pending(workspace[0], facts)
    with Session.begin() as db:
        run = db.get(Run, record[1])
        run.lease_until = now() - timedelta(seconds=1)
        db.get(Invoice, record[0]).page_data = record[4]
        revision = db.scalar(select(Revision).where(Revision.invoice_id == record[0]))
        revision.extraction = record[3]
    sent = []
    monkeypatch.setattr(
        dispatcher.process_invoice, "apply_async", lambda **kw: sent.append(kw["args"][0])
    )
    dispatcher.dispatch_once()
    assert record[1] in sent
    pipeline.process(record[1])
    pipeline.finalize(record[1], record[2], record[3], record[4], {"model": "stale-test-worker"})
    with Session() as db:
        assert db.get(Run, record[1]).attempt == 2
        assert db.get(Run, record[1]).state == "COMPLETED"
        assert (
            db.scalar(
                select(func.count())
                .select_from(Commitment)
                .where(Commitment.invoice_id == record[0])
            )
            == 1
        )


def test_events_persist_monotonic_and_resume(workspace, facts):
    from ap.main import events_payload

    record = pending(workspace[0], facts)
    finish(record)
    with Session() as db:
        events = events_payload(db, record[0])
        assert len(events) == 2
        assert events[1].id > events[0].id
        assert [e.id for e in events_payload(db, record[0], events[0].id)] == [events[1].id]


def test_detail_uses_consistent_snapshot_during_finalization(workspace, facts):
    record = pending(workspace[0], facts)
    triggered = ThreadEvent()

    def after_invoice_read(connection, cursor, statement, parameters, context, many):
        if "FROM invoice" in statement and not triggered.is_set():
            triggered.set()
            finish(record)

    sql_event.listen(engine, "after_cursor_execute", after_invoice_read)
    try:
        response = client_for(workspace).get(f"/invoices/{record[0]}")
    finally:
        sql_event.remove(engine, "after_cursor_execute", after_invoice_read)
    assert triggered.is_set()
    assert response.status_code == 200
    snapshot = response.json()
    assert snapshot["run"]["state"] == "RUNNING"
    assert snapshot["invoice"]["outcome"] is None
    assert snapshot["decision"] is None
    current = client_for(workspace).get(f"/invoices/{record[0]}").json()
    assert current["run"]["state"] == "COMPLETED"
    assert current["invoice"]["outcome"] == current["decision"]["outcome"] == "APPROVED"
