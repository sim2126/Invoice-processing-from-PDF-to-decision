import logging
from datetime import timedelta

from openai import APIConnectionError, APIStatusError, APITimeoutError, RateLimitError
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from . import assistant, extraction, storage
from .checks import group_events, po_source, read_message
from .config import POLICY_VERSION, PROMPT_VERSION, SCHEMA_VERSION, settings
from .db import (
    PO,
    Audit,
    Commitment,
    CompanyDocument,
    Decision,
    Event,
    Invoice,
    Quota,
    Revision,
    Run,
    Session,
    Vendor,
    Workspace,
    now,
    uid,
)
from .documents import read_document, verify_evidence
from .rules import decimal, evaluate, identity

logger = logging.getLogger(__name__)


def consume_quota(db, kind: str, limit: int):
    key = f"{kind}:{now().date().isoformat()}"
    result = db.execute(
        insert(Quota)
        .values(key=key, count=1)
        .on_conflict_do_update(index_elements=[Quota.key], set_={"count": Quota.count + 1})
        .returning(Quota.count)
    ).scalar_one()
    if result > limit:
        raise extraction.ExtractionFailure(
            "The daily limit has been reached. Ask the workspace owner to review usage before continuing."
        )


def event(db, run_id, stage, state, message):
    db.add(Event(run_id=run_id, stage=stage, state=state, message=message))


def emit(run_id, token, stage, state, message):
    emit_many(run_id, token, [(stage, state, message)])


def emit_many(run_id, token, items):
    with Session.begin() as db:
        run = db.get(Run, run_id)
        if run and run.attempt_token == token and run.state == "RUNNING":
            for stage, state, message in items:
                event(db, run_id, stage, state, message)


def vendor_dict(v):
    return {
        "id": v.id,
        "name": v.name,
        "identifier": v.identifier,
        "aliases": v.aliases,
        "active": v.active,
    }


def po_dict(p):
    return {
        "id": p.id,
        "vendor_id": p.vendor_id,
        "reference": p.reference,
        "description": p.description,
        "ceiling": str(p.ceiling),
        "currency": p.currency,
        "status": p.status,
        "lines": p.lines,
    }


def financial_context(db, workspace_id, invoice_id, lock=True):
    vendors = [
        vendor_dict(v)
        for v in db.scalars(select(Vendor).where(Vendor.workspace_id == workspace_id))
    ]
    order_query = select(PO).where(PO.workspace_id == workspace_id).order_by(PO.id)
    orders = [
        po_dict(p) for p in db.scalars(order_query.with_for_update() if lock else order_query)
    ]
    commitments = [
        {"po_id": c.po_id, "amount": str(c.amount), "quantities": c.quantities}
        for c in db.scalars(select(Commitment).where(Commitment.workspace_id == workspace_id))
    ]
    prior = []
    for d in db.scalars(
        select(Decision)
        .join(Invoice, Invoice.current_decision == Decision.id)
        .where(Invoice.workspace_id == workspace_id, Invoice.id != invoice_id)
    ):
        prior.append(
            {
                "invoice_id": d.invoice_id,
                "vendor_id": d.vendor_id,
                "reference": d.extraction.get("invoice_number"),
                "total": d.extraction.get("total"),
                "date": d.extraction.get("invoice_date"),
                "currency": d.extraction.get("currency"),
            }
        )
    for c in db.scalars(
        select(Commitment).where(
            Commitment.workspace_id == workspace_id, Commitment.historical.is_(True)
        )
    ):
        prior.append(
            {
                "invoice_id": None,
                "vendor_id": c.vendor_id,
                "reference": c.identity,
                "total": str(c.amount),
                "date": c.invoice_date,
                "currency": c.currency,
            }
        )
    return vendors, orders, commitments, prior


def finalize(run_id, token, data, pages, metadata):
    """Only this transaction can accept a business commitment."""
    with Session.begin() as db:
        lookup = db.get(Run, run_id)
        if not lookup:
            return
        original_invoice = db.get(Invoice, lookup.invoice_id)
        workspace = db.execute(
            select(Workspace).where(Workspace.id == original_invoice.workspace_id).with_for_update()
        ).scalar_one()
        invoice = db.execute(
            select(Invoice)
            .where(Invoice.id == lookup.invoice_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one()
        run = db.execute(
            select(Run)
            .where(Run.id == run_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one()
        if (
            run.state != "RUNNING"
            or run.attempt_token != token
            or invoice.revision != run.revision
            or invoice.current_run != run_id
        ):
            return
        revision = db.execute(
            select(Revision).where(
                Revision.invoice_id == invoice.id, Revision.number == run.revision
            )
        ).scalar_one()
        evidence = verify_evidence(data, pages, revision.provenance.get("corrections", []))
        vendors, orders, commitments, prior = financial_context(
            db, invoice.workspace_id, invoice.id
        )
        assistance = metadata.get("assistant", {})
        if not workspace.company.get("ai_assistance", True):
            assistance = {"status": "disabled"}
        selections = dict(revision.selections)
        documents = list(
            db.scalars(
                select(CompanyDocument).where(
                    CompanyDocument.workspace_id == invoice.workspace_id,
                    CompanyDocument.archived.is_(False),
                )
            )
        )
        active_documents = {d.id: d.page_data for d in documents}
        match = assistant.grounded_match(
            data, selections, assistance, vendors, orders, active_documents
        )
        auto_po, matched_document = match or (None, None)
        if auto_po:
            selections["po_id"] = auto_po
            assistance = {**assistance, "auto_matched": True}
        result = evaluate(
            data, evidence, vendors, orders, commitments, prior, selections, now().date()
        )
        # A proposal predates this transaction and the supported PO selection.
        # Applying a PO can change the outstanding checks without changing the
        # overall outcome; always refresh its explanation from the final policy.
        if assistance.get("status") == "ready" and (
            auto_po or metadata.get("assistant_outcome") != result["outcome"]
        ):
            assistance = {
                **assistance,
                "next_step": result["next_action"],
                "question": None,
                "draft_message": None,
                "explanation": (
                    "A supported purchase-order match was applied. "
                    if auto_po
                    else "Workspace balances changed while this invoice was processing. "
                )
                + result["summary"],
            }
        # Missing PO evidence needs a usable next step even if the model omits
        # its optional question or draft. This template never selects an order.
        if (
            assistance.get("status") == "ready"
            and result["outcome"] == "NEEDS_REVIEW"
            and result["po_id"] is None
            and not data.get("po_reference")
            and not data.get("po_references")
            and data.get("invoice_number")
            and data.get("vendor_identifier")
        ):
            invoice_reference = " ".join(str(data["invoice_number"]).split())[:100]
            supplier_reference = " ".join(str(data["vendor_identifier"]).split())[:100]
            if invoice_reference and supplier_reference:
                fallback = {}
                if assistance.get("question") is None:
                    fallback["question"] = (
                        f"Which purchase order is invoice {invoice_reference} "
                        f"from supplier {supplier_reference} assigned to?"
                    )
                if assistance.get("draft_message") is None:
                    fallback["draft_message"] = (
                        "Please provide a procurement confirmation that explicitly assigns "
                        f"invoice {invoice_reference} from supplier {supplier_reference} "
                        "to the correct purchase order, including its PO number."
                    )
                    fallback["draft_origin"] = "policy_template"
                assistance = {**assistance, **fallback}
        run.model = metadata["model"]
        run.usage = metadata.get("usage", {})
        revision.extraction = data
        revision.provenance = {
            **revision.provenance,
            "model": run.model,
            "schema": SCHEMA_VERSION,
            "prompt": PROMPT_VERSION,
            "evidence": evidence,
            "document_hash": invoice.sha256,
            "ai_po_selection": auto_po,
        }
        decision = Decision(
            invoice_id=invoice.id,
            run_id=run.id,
            revision=run.revision,
            policy_version=POLICY_VERSION,
            document_hash=invoice.sha256,
            schema_version=SCHEMA_VERSION,
            prompt_version=PROMPT_VERSION,
            model=run.model,
            extraction={**data, "verified_evidence": evidence},
            assistant=assistance,
            **{
                k: result[k]
                for k in [
                    "outcome",
                    "checks",
                    "summary",
                    "next_action",
                    "owner",
                    "vendor_id",
                    "po_id",
                    "comparison",
                    "duplicate_id",
                ]
            },
        )
        db.add(decision)
        db.flush()
        if result["outcome"] == "APPROVED":
            db.add(
                Commitment(
                    workspace_id=invoice.workspace_id,
                    invoice_id=invoice.id,
                    vendor_id=result["vendor_id"],
                    po_id=result["po_id"],
                    identity=identity(data["invoice_number"]),
                    invoice_date=data["invoice_date"],
                    currency=data["currency"],
                    amount=decimal(data["total"]),
                    quantities=result["allocations"],
                )
            )
        invoice.current_decision = decision.id
        invoice.page_data = pages
        run.state, run.finished_at, run.lease_until = "COMPLETED", now(), None
        run.error = None
        event(
            db,
            run_id,
            "checks",
            "passed",
            "Evidence, matching, arithmetic, duplicate and cumulative checks recorded.",
        )
        # The authoritative per-group results, replacing the preliminary ones.
        source = po_source(data, revision.selections, auto_matched=bool(auto_po))
        for stage, state, message in group_events(result, data, po_source=source):
            event(db, run_id, stage, state, message)
        event(
            db,
            run_id,
            "decision",
            "passed"
            if result["outcome"] == "APPROVED"
            else "blocked"
            if result["outcome"] == "BLOCKED"
            else "review",
            result["summary"],
        )
        ai_audit = document_review_audit(
            data, result, assistance, revision, auto_po, matched_document, orders, documents
        )
        if ai_audit:
            db.add(
                Audit(
                    invoice_id=invoice.id,
                    run_id=run_id,
                    actor="AI assistant",
                    revision=run.revision,
                    policy_version=POLICY_VERSION,
                    before={},
                    **ai_audit,
                )
            )
        db.add(
            Audit(
                invoice_id=invoice.id,
                run_id=run_id,
                actor="Policy engine",
                action="DECISION",
                revision=run.revision,
                policy_version=POLICY_VERSION,
                before={},
                after={"outcome": result["outcome"], "decision_id": decision.id},
                reason=result["summary"],
            )
        )


def document_review_audit(
    data, result, assistance, revision, auto_po, document_id, orders, documents
):
    """What the AI found in company documents, in plain words for the audit trail.

    A match is recorded whenever one is applied. "No match" is recorded only
    for a review a person asked for, when the assistant really read the
    documents and the invoice still has no order: no PO printed or chosen, and
    a confirmed supplier (matching is per supplier).
    """
    if auto_po:
        reference = next(o["reference"] for o in orders if o["id"] == auto_po)
        name = next(d.filename for d in documents if d.id == document_id)
        return {
            "action": "AI_MATCH",
            "after": {"po_reference": reference, "document": name, "document_id": document_id},
            "reason": f"Matched {reference} from the company document '{name}'.",
        }
    if (
        revision.provenance.get("ai_review")
        and assistance.get("status") == "ready"
        and result["vendor_id"] is not None
        and result["po_id"] is None
        and not data.get("po_reference")
        and not data.get("po_references")
        and not revision.selections.get("po_id")
    ):
        checked = len(documents)
        return {
            "action": "AI_NO_MATCH",
            "after": {"documents_checked": checked},
            "reason": f"No company document assigns this invoice to an order ({checked} on file).",
        }
    return None


def process(run_id):
    token = uid()
    with Session.begin() as db:
        run = db.execute(select(Run).where(Run.id == run_id).with_for_update()).scalar_one_or_none()
        if not run or run.state in ("COMPLETED", "FAILED"):
            return
        if run.state == "RUNNING" and run.lease_until and run.lease_until > now():
            return
        if run.retry_at and run.retry_at > now():
            return
        if run.attempt >= 3:
            run.state, run.error, run.finished_at = (
                "FAILED",
                "Processing stopped after three attempts. Retry when the service is available.",
                now(),
            )
            event(db, run_id, "recovery", "failed", run.error)
            return
        invoice = db.get(Invoice, run.invoice_id)
        if invoice.current_run != run.id or invoice.revision != run.revision:
            run.state, run.error, run.finished_at = (
                "FAILED",
                "A newer revision superseded this run.",
                now(),
            )
            return
        run.attempt += 1
        run.state, run.attempt_token = "RUNNING", token
        run.started_at = run.started_at or now()
        run.lease_until = now() + timedelta(minutes=5)
        run.error = None
        event(db, run_id, "read", "running", "Reading the source document.")
        revision = db.execute(
            select(Revision).where(
                Revision.invoice_id == invoice.id, Revision.number == run.revision
            )
        ).scalar_one()
        invoice_id, object_key, workspace_id = invoice.id, invoice.object_key, invoice.workspace_id
        existing_data, provenance, pages = (
            revision.extraction,
            revision.provenance,
            invoice.page_data,
        )
    try:
        if not pages:
            document = storage.get(object_key)
            pages, images = read_document(document)
            for i, image in enumerate(images):
                key = storage.page_key(workspace_id, invoice_id, object_key, i + 1)
                # Fixture-backed history already ships its rendered pages.
                if not key.startswith(storage.FIXTURE_PREFIX):
                    storage.put(key, image, "image/png")
            with Session.begin() as db:
                invoice = db.get(Invoice, invoice_id)
                invoice.page_data = pages
        else:
            document = storage.get(object_key) if existing_data is None else b""
        emit(run_id, token, "read", "passed", read_message(pages))
        if existing_data is None:
            emit(
                run_id, token, "extract", "running", "Extracting invoice facts and source evidence."
            )
            with Session.begin() as db:
                consume_quota(db, "model", settings.global_calls)
                consume_quota(db, f"model-session:{workspace_id}", settings.session_calls)
            data, metadata = extraction.extract(document)
        else:
            data = existing_data
            metadata = {"model": provenance.get("model", settings.model), "usage": {}}
            emit(
                run_id,
                token,
                "extract",
                "passed",
                "Using the fields already read from this document, with any reviewer changes; every check runs again.",
            )
        emit(
            run_id,
            token,
            "extract",
            "passed",
            "Structured invoice facts received. Approval is determined by the policy checks.",
        )
        emit(
            run_id,
            token,
            "checks",
            "running",
            "Verifying evidence and current purchase-order commitments.",
        )
        preliminary = preliminary_checks(workspace_id, invoice_id, data, pages, provenance, run_id)
        if preliminary:
            emit_many(run_id, token, preliminary["events"])
        metadata.update(
            prepare_assistance(
                workspace_id,
                invoice_id,
                data,
                pages,
                provenance,
                run_id,
                token,
                result=preliminary and preliminary["result"],
            )
        )
        finalize(run_id, token, data, pages, metadata)
    except Exception as exc:
        transient = isinstance(exc, (APIConnectionError, APITimeoutError, RateLimitError)) or (
            isinstance(exc, APIStatusError) and exc.status_code >= 500
        )
        # Provider bodies, document content and credentials must not be logged.
        logger.warning("Run %s failed (%s)", run_id, type(exc).__name__)
        with Session.begin() as db:
            run = db.execute(select(Run).where(Run.id == run_id).with_for_update()).scalar_one()
            if run.attempt_token != token or run.state != "RUNNING":
                return
            message = (
                str(exc)
                if isinstance(exc, extraction.ExtractionFailure)
                else "The document could not be processed. No new decision was made. Retry, or ask the workspace owner to check the extraction service."
            )
            run.error = message
            run.lease_until = None
            if transient and run.attempt < 3:
                run.state, run.dispatched_at = "QUEUED", None
                run.retry_at = now() + timedelta(seconds=5 * 2**run.attempt)
                event(
                    db,
                    run_id,
                    "recovery",
                    "pending",
                    "Temporary extraction interruption. A bounded retry has been scheduled.",
                )
            else:
                run.state, run.finished_at = "FAILED", now()
                event(db, run_id, "processing", "failed", message)


def run_selections(db, run_id):
    revision = db.scalar(
        select(Revision)
        .join(Run, Run.invoice_id == Revision.invoice_id)
        .where(Run.id == run_id, Revision.number == Run.revision)
    )
    return dict(revision.selections) if revision else {}


def preliminary_checks(workspace_id, invoice_id, data, pages, provenance, run_id):
    """Unlocked evaluation shown while assistance runs; finalize alone decides.

    Runs for every invoice, with AI assistance on or off. Failure only costs
    the early progress events, never the decision.
    """
    try:
        with Session() as db:
            context = financial_context(db, workspace_id, invoice_id, lock=False)
            selections = run_selections(db, run_id)
        evidence = verify_evidence(data, pages, provenance.get("corrections", []))
        result = evaluate(data, evidence, *context, selections, now().date())
        source = po_source(data, selections)
        return {"result": result, "events": group_events(result, data, po_source=source)}
    except Exception as exc:
        logger.warning("Preliminary checks unavailable for run %s (%s)", run_id, type(exc).__name__)
        return None


def prepare_assistance(
    workspace_id, invoice_id, data, pages, provenance, run_id, token, result=None
):
    """Network call outside any row-locking financial transaction; fail softly."""
    try:
        with Session() as db:
            workspace = db.get(Workspace, workspace_id)
            if not workspace.company.get("ai_assistance", True):
                return {"assistant": {"status": "disabled"}}
            context = financial_context(db, workspace_id, invoice_id, lock=False)
            if result is None:
                evidence = verify_evidence(data, pages, provenance.get("corrections", []))
                selections = run_selections(db, run_id)
                result = evaluate(data, evidence, *context, selections, now().date())
            sources, candidates = assistant.retrieve(db, workspace_id, data, pages, *context[:2])
        emit(
            run_id,
            token,
            "assist",
            "running",
            "Reading workspace references and preparing a cited next step.",
        )
        with Session.begin() as db:
            consume_quota(db, "model", settings.global_calls)
            consume_quota(db, f"model-session:{workspace_id}", settings.session_calls)
        assistance = assistant.recommend(data, result, sources, candidates)
        emit(
            run_id,
            token,
            "assist",
            "passed",
            "AI recommendation prepared with verified source quotations.",
        )
        return {"assistant": assistance, "assistant_outcome": result["outcome"]}
    except Exception as exc:
        logger.warning("Assistant unavailable for run %s (%s)", run_id, type(exc).__name__)
        emit(
            run_id,
            token,
            "assist",
            "review",
            "AI assistance is unavailable. Exact policy checks still run.",
        )
        return {"assistant": {"status": "unavailable"}}
