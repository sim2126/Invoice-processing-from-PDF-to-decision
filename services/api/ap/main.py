import asyncio
import copy
import hashlib
import io
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import Depends, FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select, text
from starlette.concurrency import run_in_threadpool

from . import storage
from .auth import check_origin, database, mutation, session, session_payload
from .config import POLICY_VERSION, ROOT, settings
from .db import (
    PO,
    Audit,
    Decision,
    Event,
    Invoice,
    Member,
    Policy,
    Revision,
    Run,
    Session,
    Vendor,
    Workspace,
    now,
    uid,
)
from .documents import DocumentError, get_value, validate_pdf, value_supported
from .extraction import ExtractionFailure
from .followup_examples import router as followup_router
from .pipeline import consume_quota, event, po_dict, vendor_dict
from .product import router as product_router
from .rules import vendor_candidates
from .schemas import (
    DecisionResponse,
    DetailResponse,
    EventResponse,
    Extraction,
    InvoiceRow,
    QueueResponse,
    RetryRequest,
    ReviewRequest,
    SessionResponse,
    UploadResponse,
)
from .seed import seed_workspace

app = FastAPI(title="AP Review Desk", version="0.1.0")
app.include_router(product_router)
app.include_router(followup_router)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "same-origin"
    return response


def owned(db, invoice_id, workspace):
    invoice = db.get(Invoice, invoice_id)
    if not invoice or invoice.workspace_id != workspace.id:
        raise HTTPException(404, "Invoice not found in this demo workspace.")
    return invoice


@app.get("/health")
def health(db=Depends(database)):
    db.execute(text("SELECT 1"))
    return {"status": "ok"}


@app.get("/ready")
def ready(db=Depends(database)):
    from redis import Redis

    db.execute(text("SELECT 1 FROM alembic_version"))
    Redis.from_url(settings.redis_url, socket_timeout=3).ping()
    storage.client().head_bucket(Bucket=settings.s3_bucket)
    return {
        "infrastructure": "ready",
        "extraction_configured": bool(settings.api_key and settings.model),
    }


@app.post("/session", response_model=SessionResponse)
def create_session(request: Request, response: Response, db=Depends(database)):
    check_origin(request)
    try:
        consume_quota(db, "sessions", 200)
        w, token = seed_workspace(db)
        db.flush()
        w.current_member = db.scalar(select(Member).where(Member.workspace_id == w.id))
        db.commit()
    except ExtractionFailure as exc:
        db.rollback()
        raise HTTPException(429, str(exc)) from exc
    response.set_cookie(
        "ap_session",
        token,
        max_age=settings.session_hours * 3600,
        httponly=True,
        secure=settings.secure,
        samesite="lax",
        path="/",
    )
    return session_payload(w)


@app.get("/session", response_model=SessionResponse)
def get_session(workspace=Depends(session)):
    return session_payload(workspace)


def row(db, inv):
    run = db.get(Run, inv.current_run)
    decision = db.get(Decision, inv.current_decision) if inv.current_decision else None
    revision = db.scalar(
        select(Revision).where(Revision.invoice_id == inv.id, Revision.number == inv.revision)
    )
    data = revision.extraction or (decision.extraction if decision else {})
    applicable = bool(decision and decision.revision == inv.revision)
    return InvoiceRow(
        id=inv.id,
        filename=inv.filename,
        reference=data.get("invoice_number"),
        vendor=data.get("vendor_name"),
        total=data.get("total"),
        currency=data.get("currency"),
        po_reference=decision.comparison.get("po_reference")
        if applicable
        else data.get("po_reference"),
        execution=run.state,
        outcome=decision.outcome if applicable else None,
        decision_applicable=applicable,
        revision=inv.revision,
        human_touched=inv.human_touched,
        summary=run.error
        if run.state == "FAILED"
        else decision.summary
        if applicable
        else "Waiting for document checks.",
        created_at=inv.created_at.isoformat(),
    )


@app.get("/invoices", response_model=QueueResponse)
def list_invoices(workspace=Depends(session), db=Depends(database)):
    invoices = [
        row(db, inv)
        for inv in db.scalars(
            select(Invoice)
            .where(Invoice.workspace_id == workspace.id)
            .order_by(Invoice.created_at.desc())
        )
    ]
    completed = [i for i in invoices if i.execution == "COMPLETED" and i.decision_applicable]
    review = sum(i.outcome == "NEEDS_REVIEW" for i in completed)
    automatic = sum(i.outcome == "APPROVED" and not i.human_touched for i in completed)
    durations = []
    for inv in invoices:
        if inv.execution == "COMPLETED":
            r = db.scalar(
                select(Run).join(Invoice, Invoice.current_run == Run.id).where(Invoice.id == inv.id)
            )
            if r.finished_at:
                durations.append((r.finished_at - r.created_at).total_seconds())
    durations.sort()
    median = None
    if durations:
        n = len(durations)
        median = f"{(durations[(n - 1) // 2] + durations[n // 2]) / 2:.1f}"
    return QueueResponse(
        invoices=invoices,
        scope="Current demo session · unique uploaded invoices · historical commitments excluded",
        metrics={
            "uploaded": len(invoices),
            "processed": len(completed),
            "review": review,
            "review_rate": f"{review * 100 / len(completed):.0f}" if completed else None,
            "auto_approved": automatic,
            "auto_rate": f"{automatic * 100 / len(completed):.0f}" if completed else None,
            "failed": sum(i.execution == "FAILED" for i in invoices),
            "median_seconds": median,
            "duration_samples": len(durations),
        },
    )


@app.post("/invoices", response_model=UploadResponse, status_code=201)
async def upload(file: UploadFile, workspace=Depends(mutation), db=Depends(database)):
    filename = re.sub(
        r"[^\w .()-]", "_", Path((file.filename or "invoice.pdf").replace("\\", "/")).name
    )[:160]
    if not filename.lower().endswith(".pdf") or file.content_type not in (
        "application/pdf",
        "application/octet-stream",
    ):
        raise HTTPException(422, "Choose a PDF invoice.")
    data = await file.read(settings.max_bytes + 1)
    await file.close()
    try:
        pages = await run_in_threadpool(validate_pdf, data)
    except DocumentError as exc:
        raise HTTPException(422, str(exc)) from exc
    sha = hashlib.sha256(data).hexdigest()
    existing = db.scalar(
        select(Invoice).where(Invoice.workspace_id == workspace.id, Invoice.sha256 == sha)
    )
    if existing:
        return UploadResponse(id=existing.id, existing=True)
    invoice_id, run_id = uid(), uid()
    object_key = f"{workspace.id}/{invoice_id}/source.pdf"
    # S3 is outside the financial transaction; unreferenced objects are safe to garbage-collect.
    try:
        storage.put(object_key, data)
    except Exception as exc:
        raise HTTPException(
            503, "Document storage is unavailable. No invoice was submitted. Try again shortly."
        ) from exc
    locked = db.execute(
        select(Workspace).where(Workspace.id == workspace.id).with_for_update()
    ).scalar_one()
    db.refresh(locked)
    existing = db.scalar(
        select(Invoice).where(Invoice.workspace_id == workspace.id, Invoice.sha256 == sha)
    )
    if existing:
        db.rollback()
        return UploadResponse(id=existing.id, existing=True)
    if locked.uploads >= settings.session_uploads:
        raise HTTPException(429, "This session's upload limit has been reached.")
    try:
        consume_quota(db, "uploads", settings.global_uploads)
    except ExtractionFailure as exc:
        db.rollback()
        raise HTTPException(429, str(exc)) from exc
    inv = Invoice(
        id=invoice_id,
        workspace_id=workspace.id,
        filename=filename,
        sha256=sha,
        object_key=object_key,
        pages=pages,
        current_run=run_id,
    )
    db.add(inv)
    db.flush()
    db.add(Revision(invoice_id=invoice_id, number=1, selections={}, provenance={}))
    db.add(Run(id=run_id, invoice_id=invoice_id, revision=1))
    db.flush()
    locked.uploads += 1
    event(db, run_id, "intake", "passed", f"PDF accepted · {pages} page(s). Queued for processing.")
    db.add(
        Audit(
            invoice_id=invoice_id,
            run_id=run_id,
            actor=workspace.current_member.name,
            action="UPLOAD",
            revision=1,
            policy_version=POLICY_VERSION,
            before={},
            after={"filename": filename, "sha256": sha},
            reason="Invoice uploaded for review.",
        )
    )
    db.commit()
    return UploadResponse(id=invoice_id, existing=False)


def decision_payload(d):
    return DecisionResponse(
        **{
            k: getattr(d, k)
            for k in [
                "id",
                "run_id",
                "revision",
                "outcome",
                "summary",
                "next_action",
                "owner",
                "checks",
                "comparison",
                "duplicate_id",
                "policy_version",
                "extraction",
                "assistant",
            ]
        },
        created_at=d.created_at.isoformat(),
    )


def events_payload(db, invoice_id, after=0):
    return [
        EventResponse(
            id=e.id,
            run_id=e.run_id,
            stage=e.stage,
            state=e.state,
            message=e.message,
            at=e.at.isoformat(),
        )
        for e in db.scalars(
            select(Event)
            .join(Run, Event.run_id == Run.id)
            .where(Run.invoice_id == invoice_id, Event.id > after)
            .order_by(Event.id)
        )
    ]


@app.get("/invoices/{invoice_id}", response_model=DetailResponse)
def detail(invoice_id: str, workspace=Depends(session), db=Depends(database)):
    inv = owned(db, invoice_id, workspace)
    current = db.get(Run, inv.current_run)
    history = list(
        db.scalars(
            select(Decision)
            .where(Decision.invoice_id == inv.id)
            .order_by(Decision.created_at.desc())
        )
    )
    rev = db.scalar(
        select(Revision).where(Revision.invoice_id == inv.id, Revision.number == inv.revision)
    )
    vendors = [
        vendor_dict(v)
        for v in db.scalars(select(Vendor).where(Vendor.workspace_id == workspace.id))
    ]
    matches = vendor_candidates(rev.extraction or {}, vendors)
    vendor_id = rev.selections.get("vendor_id") or (matches[0]["id"] if len(matches) == 1 else None)
    orders = [
        po_dict(p)
        for p in db.scalars(
            select(PO).where(
                PO.workspace_id == workspace.id, PO.vendor_id == vendor_id, PO.status == "ACTIVE"
            )
        )
    ]
    return DetailResponse(
        invoice=row(db, inv),
        pages=inv.pages,
        run={
            "id": current.id,
            "state": current.state,
            "attempt": current.attempt,
            "error": current.error,
            "started_at": current.started_at.isoformat() if current.started_at else None,
            "finished_at": current.finished_at.isoformat() if current.finished_at else None,
        },
        decision=decision_payload(history[0]) if history else None,
        history=[decision_payload(h) for h in history],
        extraction=rev.extraction,
        evidence=rev.provenance.get("evidence", []),
        events=events_payload(db, inv.id),
        audit=[
            {
                "id": a.id,
                "action": a.action,
                "actor": a.actor,
                "reason": a.reason,
                "before": a.before,
                "after": a.after,
                "revision": a.revision,
                "run_id": a.run_id,
                "policy_version": a.policy_version,
                "at": a.at.isoformat(),
            }
            for a in db.scalars(
                select(Audit).where(Audit.invoice_id == inv.id).order_by(Audit.at.desc())
            )
        ],
        candidates={"vendors": vendors, "orders": orders},
        policy={"version": POLICY_VERSION, **db.get(Policy, POLICY_VERSION).rules},
    )


def lock_for_action(db, workspace, invoice_id, revision):
    db.execute(select(Workspace).where(Workspace.id == workspace.id).with_for_update()).scalar_one()
    inv = db.execute(
        select(Invoice)
        .where(Invoice.id == invoice_id, Invoice.workspace_id == workspace.id)
        .with_for_update()
    ).scalar_one_or_none()
    if inv is None:
        raise HTTPException(404, "Invoice not found.")
    if inv.revision != revision:
        raise HTTPException(
            409,
            "This invoice changed while you were reviewing it. Reload the current revision before making changes.",
        )
    d = db.get(Decision, inv.current_decision) if inv.current_decision else None
    if d and d.outcome == "APPROVED":
        raise HTTPException(
            409, "Accepted invoices are immutable. Contact AP for the external reversal process."
        )
    return inv


@app.post("/invoices/{invoice_id}/review", response_model=UploadResponse)
def review(
    invoice_id: str, payload: ReviewRequest, workspace=Depends(mutation), db=Depends(database)
):
    inv = lock_for_action(db, workspace, invoice_id, payload.expected_revision)
    current_run = db.get(Run, inv.current_run)
    if current_run.state in ("QUEUED", "RUNNING"):
        raise HTTPException(
            409, "Wait for the current checks to finish before changing the invoice."
        )
    rev = db.scalar(
        select(Revision).where(Revision.invoice_id == inv.id, Revision.number == inv.revision)
    )
    if not rev.extraction:
        raise HTTPException(
            409,
            "A complete extraction is required before correction. Retry document processing first.",
        )
    data, selections = copy.deepcopy(rev.extraction), dict(rev.selections)
    before, after = {}, {}
    corrections = {c["field"]: c for c in rev.provenance.get("corrections", [])}
    for correction in payload.corrections:
        field = correction.field
        if not (
            field
            in {
                "vendor_name",
                "vendor_identifier",
                "invoice_number",
                "invoice_date",
                "due_date",
                "po_reference",
                "currency",
                "subtotal",
                "header_discount",
                "shipping",
                "tax",
                "tax_rate",
                "total",
            }
            or re.fullmatch(
                r"lines\.\d+\.(quantity|unit_price|discount|total|sku|description|unit)", field
            )
        ):
            raise HTTPException(422, "This field cannot be corrected in this review flow.")
        if correction.page > inv.pages or not value_supported(
            correction.value, correction.source_text, field
        ):
            raise HTTPException(
                422,
                "The correction must cite a valid source page and text that supports the new value.",
            )
        before[field] = get_value(data, field)
        if field.startswith("lines."):
            _, index, name = field.split(".")
            if int(index) >= len(data["lines"]):
                raise HTTPException(422, "Invoice line does not exist.")
            data["lines"][int(index)][name] = correction.value
        else:
            data[field] = correction.value
        after[field] = correction.value
        corrections[field] = correction.model_dump()
    if payload.vendor_id:
        vendor = db.get(Vendor, payload.vendor_id)
        if not vendor or vendor.workspace_id != workspace.id:
            raise HTTPException(422, "Select a vendor from this workspace's approved register.")
        before["vendor_selection"], after["vendor_selection"] = (
            selections.get("vendor_id"),
            vendor.name,
        )
        selections["vendor_id"] = vendor.id
    if payload.po_id:
        po = db.get(PO, payload.po_id)
        vendors = [
            vendor_dict(v)
            for v in db.scalars(select(Vendor).where(Vendor.workspace_id == workspace.id))
        ]
        matches = vendor_candidates(data, vendors)
        vendor_id = selections.get("vendor_id") or (matches[0]["id"] if len(matches) == 1 else None)
        if (
            not po
            or po.workspace_id != workspace.id
            or po.vendor_id != vendor_id
            or po.status != "ACTIVE"
            or po.currency != data.get("currency")
        ):
            raise HTTPException(
                422, "Select an active purchase order for the confirmed vendor and currency."
            )
        before["purchase_order"], after["purchase_order"] = (
            selections.get("po_id") or data.get("po_reference"),
            po.reference,
        )
        selections["po_id"] = po.id
    Extraction.model_validate(data)
    inv.revision += 1
    inv.human_touched = True
    run_id = uid()
    inv.current_run = run_id
    db.add(
        Revision(
            invoice_id=inv.id,
            number=inv.revision,
            extraction=data,
            selections=selections,
            provenance={
                **rev.provenance,
                "corrections": list(corrections.values()),
                "source_revision": rev.number,
            },
        )
    )
    db.add(Run(id=run_id, invoice_id=inv.id, revision=inv.revision))
    db.flush()
    event(
        db,
        run_id,
        "review",
        "passed",
        "Reviewer changes recorded. All checks will run against current PO balances.",
    )
    db.add(
        Audit(
            invoice_id=inv.id,
            run_id=run_id,
            actor=workspace.current_member.name,
            action="REVIEW",
            revision=inv.revision,
            policy_version=POLICY_VERSION,
            before=before,
            after=after,
            reason=payload.reason.strip(),
        )
    )
    db.commit()
    return UploadResponse(id=inv.id, existing=False)


@app.post("/invoices/{invoice_id}/retry", response_model=UploadResponse)
def retry(
    invoice_id: str, payload: RetryRequest, workspace=Depends(mutation), db=Depends(database)
):
    inv = lock_for_action(db, workspace, invoice_id, payload.expected_revision)
    run = db.get(Run, inv.current_run)
    if run.state != "FAILED":
        raise HTTPException(
            409,
            "Only failed processing can be retried. Use a reasoned review to rerun completed checks.",
        )
    if db.scalar(select(Run.id).where(Run.invoice_id == inv.id).offset(8).limit(1)):
        raise HTTPException(
            429,
            "Retry limit reached for this invoice. Ask the workspace owner to inspect the failure.",
        )
    run_id = uid()
    inv.current_run = run_id
    db.add(Run(id=run_id, invoice_id=inv.id, revision=inv.revision))
    db.flush()
    event(
        db, run_id, "retry", "pending", "Processing retry requested. Previous history is preserved."
    )
    db.add(
        Audit(
            invoice_id=inv.id,
            run_id=run_id,
            actor=workspace.current_member.name,
            action="RETRY",
            revision=inv.revision,
            policy_version=POLICY_VERSION,
            before={"run": run.id},
            after={"run": run_id},
            reason="Retry failed processing.",
        )
    )
    db.commit()
    return UploadResponse(id=inv.id, existing=False)


@app.get("/invoices/{invoice_id}/source")
def source(invoice_id: str, workspace=Depends(session), db=Depends(database)):
    inv = owned(db, invoice_id, workspace)
    return Response(
        storage.get(inv.object_key),
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="invoice.pdf"'},
    )


@app.get("/invoices/{invoice_id}/pages/{page}")
def page_image(invoice_id: str, page: int, workspace=Depends(session), db=Depends(database)):
    inv = owned(db, invoice_id, workspace)
    if not 1 <= page <= inv.pages or not inv.page_data:
        raise HTTPException(404, "The source page is still being prepared.")
    return Response(
        storage.get(f"{workspace.id}/{invoice_id}/page-{page}.png"), media_type="image/png"
    )


@app.get("/invoices/{invoice_id}/export")
def export(invoice_id: str, workspace=Depends(session), db=Depends(database)):
    record = detail(invoice_id, workspace, db).model_dump()
    inv = owned(db, invoice_id, workspace)
    record["provenance"] = {
        "document_sha256": inv.sha256,
        "identity_limit": "Named workspace member with bearer-link access; email is not verified",
        "decisions": [
            {
                "id": d.id,
                "model": d.model,
                "schema": d.schema_version,
                "prompt": d.prompt_version,
                "revision": d.revision,
                "policy": d.policy_version,
            }
            for d in db.scalars(select(Decision).where(Decision.invoice_id == inv.id))
        ],
    }
    return JSONResponse(
        record, headers={"Content-Disposition": 'attachment; filename="decision-record.json"'}
    )


@app.get("/invoices/{invoice_id}/events")
async def stream(
    invoice_id: str, request: Request, workspace=Depends(session), db=Depends(database)
):
    owned(db, invoice_id, workspace)
    try:
        after = max(
            0, int(request.headers.get("last-event-id") or request.query_params.get("after", "0"))
        )
    except ValueError as exc:
        raise HTTPException(422, "Invalid event cursor.") from exc
    expiry = workspace.expires_at
    member_id = workspace.current_member.id
    # Release the dependency's connection before holding an SSE stream open.
    db.rollback()

    async def events():
        cursor = after
        ticks = 0
        while not await request.is_disconnected():
            if expiry <= now():
                yield "event: session_expired\ndata: {}\n\n"
                return
            with Session() as event_db:
                member = event_db.get(Member, member_id)
                if not member or not member.active:
                    yield "event: session_expired\ndata: {}\n\n"
                    return
                batch = events_payload(event_db, invoice_id, cursor)
            for e in batch:
                cursor = e.id
                yield f"id: {e.id}\nevent: progress\ndata: {e.model_dump_json()}\n\n"
            if ticks % 15 == 0:
                yield ": heartbeat\n\n"
            ticks += 1
            await asyncio.sleep(1)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache, no-transform"},
    )


SCENARIOS = [
    {
        "id": "clean",
        "title": "A clean match",
        "description": "A $1,200 partial invoice. Every check has a source.",
        "file": "01-clean.pdf",
        "expected": "Approved",
    },
    {
        "id": "duplicate",
        "title": "Same invoice, new PDF",
        "description": "Run the clean invoice first. A new layout must not book it twice.",
        "file": "02-duplicate.pdf",
        "expected": "Blocked after clean",
    },
    {
        "id": "overrun",
        "title": "A PO at its limit",
        "description": "$4,500 invoiced against $4,000 remaining. Procurement must act.",
        "file": "03-overrun.pdf",
        "expected": "Review required",
    },
    {
        "id": "ambiguous",
        "title": "Two possible orders",
        "description": "Confirm the purchase order, add a reason, and run checks again.",
        "file": "04-ambiguous.pdf",
        "expected": "Review → approval",
    },
    {
        "id": "scan",
        "title": "The numbers disagree",
        "description": "A real scanned invoice with inconsistent printed totals.",
        "file": "05-scan-conflict.pdf",
        "expected": "Review required",
    },
]


@app.get("/scenarios")
def scenarios(workspace=Depends(session)):
    return SCENARIOS


def scenario_file(scenario_id: str):
    scenario = next((s for s in SCENARIOS if s["id"] == scenario_id), None)
    if not scenario:
        raise HTTPException(404, "Scenario not found.")
    return ROOT / "fixtures" / "pdfs" / scenario["file"]


@app.get("/scenarios/pack")
def sample_pack(workspace=Depends(session)):
    instructions = (
        "AP Review Desk - synthetic demo pack\n\n"
        "Open the review desk and choose Demo library. All five PDFs are built in.\n"
        "Use the eye icon to preview a PDF, Run scenario to process it, or Upload invoice\n"
        "to upload a file from this pack. Both routes use real PDF extraction and checks.\n"
        "Start fresh demo restores the original fictional vendor and PO balances.\n"
        "No separate vendor or PO import is needed.\n\n"
        "Run 01-clean.pdf before 02-duplicate.pdf in the same workspace.\n"
        "PO-1042 has a $10,000 ceiling, $6,000 already accepted and $4,000 remaining.\n"
        "For 04-ambiguous.pdf, select PO-1088 in Review & resolve and record a reason.\n"
        "For 05-scan-conflict.pdf, the printed $990 total disagrees with $900 of items.\n"
        "Keep it on hold and request a corrected invoice; do not change true source facts.\n\n"
        "Expected outcomes (not guaranteed extraction results):\n"
        + "\n".join(f"{s['file']}: {s['expected']}. {s['description']}" for s in SCENARIOS)
        + "\n\nAll companies and invoices are fictional. Approval does not execute payment.\n"
    )
    output = io.BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("START-HERE.txt", instructions)
        for scenario in SCENARIOS:
            archive.write(scenario_file(scenario["id"]), arcname=scenario["file"])
    return Response(
        output.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="ap-review-desk-demo.zip"'},
    )


@app.get("/scenarios/{scenario_id}/preview")
def sample_preview(scenario_id: str, workspace=Depends(session)):
    path = scenario_file(scenario_id).with_suffix(".preview.png")
    return Response(path.read_bytes(), media_type="image/png")


@app.get("/scenarios/ambiguous/reference")
def sample_reference(workspace=Depends(session)):
    return Response(
        (ROOT / "fixtures/pdfs/project-assignment.pdf").read_bytes(),
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="project-assignment.pdf"'},
    )


@app.get("/scenarios/{scenario_id}/pdf")
def sample(scenario_id: str, workspace=Depends(session)):
    path = scenario_file(scenario_id)
    return Response(
        path.read_bytes(),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{path.name}"'},
    )
