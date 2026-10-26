"""The single intake path for invoices, whether uploaded or checked from the inbox."""

import hashlib
import re
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select

from . import storage
from .config import POLICY_VERSION, settings
from .db import Audit, Invoice, Revision, Run, Workspace, uid
from .documents import DocumentError, validate_pdf
from .extraction import ExtractionFailure
from .pipeline import consume_quota, event
from .schemas import UploadResponse

INTAKE_REASONS = {
    "upload": "Invoice uploaded for review.",
    "inbox": "Invoice received by email and checked from the inbox.",
}


def clean_filename(name: str | None) -> str:
    return re.sub(r"[^\w .()-]", "_", Path((name or "invoice.pdf").replace("\\", "/")).name)[:160]


def submit_invoice(db, workspace, filename: str, data: bytes, *, source="upload"):
    """Validate, store and queue one invoice. Idempotent per workspace by SHA-256.

    Blocking (PDF parsing, storage, database); callers in async handlers run it
    in a worker thread.
    """
    try:
        pages = validate_pdf(data)
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
        source=source,
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
            actor=workspace.current_member.name[:80],
            action="UPLOAD",
            revision=1,
            policy_version=POLICY_VERSION,
            before={},
            after={"filename": filename, "sha256": sha, "source": source},
            reason=INTAKE_REASONS[source],
        )
    )
    db.commit()
    return UploadResponse(id=invoice_id, existing=False)
