"""New arrivals for the workspace. Checking one uses exactly the upload intake.

The arrivals are PDFs built into the image (fixtures/inbox). Nothing here reads
expected outcomes or decides anything: an invoice is queued like an upload and
a reference document is stored like any company document.
"""

import hashlib
import json
import logging
from datetime import UTC, datetime, time, timedelta
from functools import lru_cache

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select

from .auth import database, mutation, session
from .config import FIXTURES
from .db import CompanyDocument, Invoice
from .intake import submit_invoice
from .product import save_reference
from .product_schemas import DocumentResponse
from .schemas import InboxItem, UploadResponse

DIRECTORY = FIXTURES / "inbox"
logger = logging.getLogger(__name__)
router = APIRouter(prefix="/inbox")


@lru_cache(maxsize=1)
def arrivals():
    try:
        manifest = json.loads((DIRECTORY / "manifest.json").read_text("utf-8"))
    except FileNotFoundError:
        logger.warning("Inbox fixtures are missing; the inbox is empty.")
        return ()
    return tuple(
        {**item, "sha256": hashlib.sha256(document(item)).hexdigest()} for item in manifest["items"]
    )


def arrival(key: str):
    item = next((item for item in arrivals() if item["key"] == key), None)
    if not item:
        raise HTTPException(404, "This message is not in the inbox.")
    return item


def document(item) -> bytes:
    return (DIRECTORY / item["filename"]).read_bytes()


@router.get("", response_model=list[InboxItem])
def inbox(workspace=Depends(session), db=Depends(database)):
    items = arrivals()
    if not items:
        return []
    digests = [item["sha256"] for item in items]
    invoices = dict(
        db.execute(
            select(Invoice.sha256, Invoice.id).where(
                Invoice.workspace_id == workspace.id, Invoice.sha256.in_(digests)
            )
        ).all()
    )
    documents = dict(
        db.execute(
            select(CompanyDocument.sha256, CompanyDocument.id).where(
                CompanyDocument.workspace_id == workspace.id,
                CompanyDocument.sha256.in_(digests),
                CompanyDocument.archived.is_(False),
            )
        ).all()
    )
    # Everything arrived shortly before the workspace was opened, keeping the
    # manifest's spacing, so arrivals read as "today" in every time zone.
    day = workspace.created_at.astimezone(UTC).date()
    latest = max(datetime.combine(day, time.fromisoformat(item["time"]), UTC) for item in items)
    opened = workspace.created_at.astimezone(UTC) - timedelta(minutes=20)
    return [
        InboxItem(
            key=item["key"],
            kind=item["kind"],
            sender=item["sender"],
            subject=item["subject"],
            received_at=(
                opened - (latest - datetime.combine(day, time.fromisoformat(item["time"]), UTC))
            ).isoformat(),
            filename=item["filename"],
            invoice_id=invoices.get(item["sha256"]),
            document_id=documents.get(item["sha256"]),
        )
        for item in items
    ]


@router.post("/{key}/check", response_model=UploadResponse)
def check(key: str, workspace=Depends(mutation), db=Depends(database)):
    item = arrival(key)
    if item["kind"] != "invoice":
        raise HTTPException(409, "This message has no invoice to check. Save it as a document.")
    return submit_invoice(db, workspace, item["filename"], document(item), source="inbox")


@router.post("/{key}/save", response_model=DocumentResponse)
def save(key: str, workspace=Depends(mutation), db=Depends(database)):
    item = arrival(key)
    if item["kind"] != "document":
        raise HTTPException(409, "This message is an invoice. Check it instead of saving it.")
    return save_reference(db, workspace, item["filename"], document(item))


@router.get("/{key}/pdf")
def pdf(key: str, workspace=Depends(session)):
    item = arrival(key)
    return Response(
        document(item),
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{item["filename"]}"'},
    )
