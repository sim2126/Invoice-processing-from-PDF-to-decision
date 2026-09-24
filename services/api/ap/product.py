import hashlib
import re
import secrets
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, UploadFile
from sqlalchemy import func, select
from starlette.concurrency import run_in_threadpool

from . import storage
from .auth import (
    DEFAULT_COMPANY,
    authenticated_mutation,
    check_origin,
    database,
    mutation,
    owner,
    session,
    session_payload,
)
from .config import settings
from .db import (
    PO,
    Commitment,
    CompanyDocument,
    Decision,
    Invitation,
    Invoice,
    Member,
    Vendor,
    Workspace,
    now,
    uid,
)
from .documents import DocumentError, read_document
from .extraction import ExtractionFailure
from .pipeline import consume_quota, po_dict
from .product_schemas import (
    AcceptInvite,
    CompanyUpdate,
    DocumentResponse,
    InvitationResponse,
    InviteCreated,
    InvitePreview,
    InviteRequest,
    InviteToken,
    MemberResponse,
    ProfileUpdate,
    SupplierDetail,
    SupplierResponse,
    TeamResponse,
)
from .rules import decimal
from .schemas import SessionResponse

router = APIRouter()


@router.post("/profile", response_model=SessionResponse)
def update_profile(
    payload: ProfileUpdate, workspace=Depends(authenticated_mutation), db=Depends(database)
):
    member = workspace.current_member
    if db.scalar(
        select(Member.id).where(
            Member.workspace_id == workspace.id,
            Member.id != member.id,
            Member.active.is_(True),
            func.lower(Member.email) == payload.email.lower(),
        )
    ):
        raise HTTPException(409, "Another workspace member already uses this email.")
    # The link establishes workspace access; the display email is not a verified login.
    member.name, member.email = payload.name, payload.email.lower()
    db.commit()
    return session_payload(workspace)


@router.post("/company", response_model=SessionResponse)
def update_company(payload: CompanyUpdate, workspace=Depends(owner), db=Depends(database)):
    workspace.company = {**workspace.company, **payload.model_dump(), "currency": "USD"}
    db.commit()
    return session_payload(workspace)


def member_view(member):
    return MemberResponse(id=member.id, name=member.name, email=member.email, role=member.role)


@router.get("/team", response_model=TeamResponse)
def team(workspace=Depends(session), db=Depends(database)):
    return TeamResponse(
        members=[
            member_view(m)
            for m in db.scalars(
                select(Member)
                .where(Member.workspace_id == workspace.id, Member.active.is_(True))
                .order_by(Member.created_at)
            )
        ],
        invitations=[
            InvitationResponse(
                id=i.id, email=i.email, role=i.role, expires_at=i.expires_at.isoformat()
            )
            for i in db.scalars(
                select(Invitation).where(
                    Invitation.workspace_id == workspace.id,
                    Invitation.revoked.is_(False),
                    Invitation.accepted_at.is_(None),
                    Invitation.expires_at > now(),
                )
            )
        ]
        if workspace.current_member.role == "owner"
        else [],
    )


@router.post("/team/invitations", response_model=InviteCreated, status_code=201)
def invite(payload: InviteRequest, workspace=Depends(owner), db=Depends(database)):
    db.execute(select(Workspace).where(Workspace.id == workspace.id).with_for_update()).scalar_one()
    count = db.scalar(
        select(func.count())
        .select_from(Member)
        .where(Member.workspace_id == workspace.id, Member.active.is_(True))
    )
    pending = db.scalar(
        select(func.count())
        .select_from(Invitation)
        .where(
            Invitation.workspace_id == workspace.id,
            Invitation.revoked.is_(False),
            Invitation.accepted_at.is_(None),
            Invitation.expires_at > now(),
        )
    )
    if count + pending >= 10:
        raise HTTPException(
            409, "This workspace supports up to ten members and pending invitations."
        )
    email = payload.email.strip().lower()
    if db.scalar(
        select(Member.id).where(
            Member.workspace_id == workspace.id,
            func.lower(Member.email) == email,
            Member.active.is_(True),
        )
    ):
        raise HTTPException(409, "This person already has workspace access.")
    if db.scalar(
        select(Invitation.id).where(
            Invitation.workspace_id == workspace.id,
            Invitation.email == email,
            Invitation.revoked.is_(False),
            Invitation.accepted_at.is_(None),
            Invitation.expires_at > now(),
        )
    ):
        raise HTTPException(
            409, "An invitation already exists. Revoke it before creating a new link."
        )
    token = secrets.token_urlsafe(32)
    invitation = Invitation(
        workspace_id=workspace.id,
        email=email,
        role=payload.role,
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
        expires_at=workspace.expires_at,
    )
    db.add(invitation)
    db.commit()
    return InviteCreated(
        id=invitation.id,
        email=email,
        role=payload.role,
        expires_at=invitation.expires_at.isoformat(),
        url=f"{settings.origin}/join#token={token}",
    )


@router.delete("/team/invitations/{invitation_id}", status_code=204)
def revoke_invitation(invitation_id: str, workspace=Depends(owner), db=Depends(database)):
    db.execute(select(Workspace).where(Workspace.id == workspace.id).with_for_update()).scalar_one()
    invitation = db.scalar(
        select(Invitation)
        .where(Invitation.id == invitation_id, Invitation.workspace_id == workspace.id)
        .with_for_update()
    )
    if not invitation:
        raise HTTPException(404, "Invitation not found.")
    invitation.revoked = True
    db.commit()
    return Response(status_code=204)


@router.delete("/team/members/{member_id}", status_code=204)
def remove_member(member_id: str, workspace=Depends(owner), db=Depends(database)):
    member = db.scalar(
        select(Member).where(Member.id == member_id, Member.workspace_id == workspace.id)
    )
    if not member:
        raise HTTPException(404, "Member not found.")
    if member.role == "owner":
        raise HTTPException(409, "The workspace owner cannot be removed.")
    member.active = False
    db.commit()
    return Response(status_code=204)


def find_invitation(db, token):
    invitation = db.scalar(
        select(Invitation).where(
            Invitation.token_hash == hashlib.sha256(token.encode()).hexdigest()
        )
    )
    workspace = db.get(Workspace, invitation.workspace_id) if invitation else None
    if (
        not invitation
        or invitation.revoked
        or invitation.accepted_at
        or invitation.expires_at <= now()
        or not workspace
        or workspace.expires_at <= now()
    ):
        raise HTTPException(
            410, "This invitation has expired, was revoked, or has already been used."
        )
    return invitation, workspace


@router.post("/invitations/preview", response_model=InvitePreview)
def preview_invitation(payload: InviteToken, request: Request, db=Depends(database)):
    check_origin(request)
    invitation, workspace = find_invitation(db, payload.token)
    return InvitePreview(
        company=workspace.company.get("name", DEFAULT_COMPANY["name"]),
        email=invitation.email,
        role=invitation.role,
        expires_at=invitation.expires_at.isoformat(),
    )


@router.post("/invitations/accept", response_model=SessionResponse)
def accept_invitation(
    payload: AcceptInvite, request: Request, response: Response, db=Depends(database)
):
    check_origin(request)
    invitation, workspace = find_invitation(db, payload.token)
    db.execute(select(Workspace).where(Workspace.id == workspace.id).with_for_update()).scalar_one()
    db.refresh(invitation, with_for_update=True)
    if invitation.accepted_at or invitation.revoked or invitation.expires_at <= now():
        raise HTTPException(410, "This invitation is no longer available.")
    if db.scalar(
        select(Member.id).where(
            Member.workspace_id == workspace.id,
            func.lower(Member.email) == invitation.email,
            Member.active.is_(True),
        )
    ):
        raise HTTPException(409, "This person already has workspace access.")
    token = secrets.token_urlsafe(32)
    member = Member(
        workspace_id=workspace.id,
        name=payload.name,
        email=invitation.email,
        role=invitation.role,
        csrf=secrets.token_urlsafe(32),
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
    )
    db.add(member)
    invitation.accepted_at = now()
    db.commit()
    workspace.current_member = member
    response.set_cookie(
        "ap_session",
        token,
        max_age=max(1, int((workspace.expires_at - now()).total_seconds())),
        httponly=True,
        secure=settings.secure,
        samesite="lax",
        path="/",
    )
    return session_payload(workspace)


def supplier_rows(db, workspace):
    rows = []
    for vendor in db.scalars(
        select(Vendor).where(Vendor.workspace_id == workspace.id).order_by(Vendor.name)
    ):
        decisions = list(
            db.scalars(
                select(Decision)
                .join(Invoice, Invoice.current_decision == Decision.id)
                .where(
                    Invoice.workspace_id == workspace.id,
                    Decision.vendor_id == vendor.id,
                    Decision.revision == Invoice.revision,
                )
            )
        )
        total = sum(
            (decimal(d.extraction.get("total")) or Decimal("0") for d in decisions), Decimal("0")
        )
        approved = sum(
            (
                decimal(d.extraction.get("total")) or Decimal("0")
                for d in decisions
                if d.outcome == "APPROVED"
            ),
            Decimal("0"),
        )
        committed = db.scalar(
            select(func.coalesce(func.sum(Commitment.amount), 0)).where(
                Commitment.workspace_id == workspace.id, Commitment.vendor_id == vendor.id
            )
        )
        orders = db.scalar(
            select(func.count())
            .select_from(PO)
            .where(
                PO.workspace_id == workspace.id, PO.vendor_id == vendor.id, PO.status == "ACTIVE"
            )
        )
        rows.append(
            SupplierResponse(
                id=vendor.id,
                name=vendor.name,
                identifier=vendor.identifier,
                active=vendor.active,
                invoice_count=len(decisions),
                invoice_value=str(total),
                approved_value=str(approved),
                committed_value=str(committed),
                open_orders=orders,
                needs_attention=sum(d.outcome != "APPROVED" for d in decisions),
            )
        )
    return rows


@router.get("/suppliers", response_model=list[SupplierResponse])
def suppliers(workspace=Depends(session), db=Depends(database)):
    return supplier_rows(db, workspace)


@router.get("/suppliers/{supplier_id}", response_model=SupplierDetail)
def supplier_detail(supplier_id: str, workspace=Depends(session), db=Depends(database)):
    from .main import row

    supplier = next((s for s in supplier_rows(db, workspace) if s.id == supplier_id), None)
    if not supplier:
        raise HTTPException(404, "Supplier not found in this workspace.")
    invoices = db.scalars(
        select(Invoice)
        .join(Decision, Invoice.current_decision == Decision.id)
        .where(
            Invoice.workspace_id == workspace.id,
            Decision.vendor_id == supplier_id,
        )
        .order_by(Invoice.created_at.desc())
    )
    orders = db.scalars(
        select(PO).where(PO.workspace_id == workspace.id, PO.vendor_id == supplier_id)
    )
    return SupplierDetail(
        supplier=supplier,
        invoices=[row(db, invoice) for invoice in invoices],
        orders=[po_dict(po) for po in orders],
    )


def document_view(document):
    return DocumentResponse(
        id=document.id,
        filename=document.filename,
        pages=len(document.page_data),
        uploaded_by=document.uploaded_by,
        created_at=document.created_at.isoformat(),
    )


@router.get("/documents", response_model=list[DocumentResponse])
def documents(workspace=Depends(session), db=Depends(database)):
    return [
        document_view(document)
        for document in db.scalars(
            select(CompanyDocument)
            .where(
                CompanyDocument.workspace_id == workspace.id,
                CompanyDocument.archived.is_(False),
            )
            .order_by(CompanyDocument.created_at.desc())
        )
    ]


@router.post("/documents", response_model=DocumentResponse, status_code=201)
async def upload_document(file: UploadFile, workspace=Depends(mutation), db=Depends(database)):
    raw = await file.read(settings.max_bytes + 1)
    await file.close()
    digest = hashlib.sha256(raw).hexdigest()
    existing = db.scalar(
        select(CompanyDocument).where(
            CompanyDocument.workspace_id == workspace.id, CompanyDocument.sha256 == digest
        )
    )
    if existing and not existing.archived:
        return document_view(existing)
    count = db.scalar(
        select(func.count())
        .select_from(CompanyDocument)
        .where(CompanyDocument.workspace_id == workspace.id, CompanyDocument.archived.is_(False))
    )
    if count >= 20:
        raise HTTPException(
            409, "Archive a reference document before adding another. Limit: 20 active PDFs."
        )
    try:
        consume_quota(db, "reference-uploads", 300)
        consume_quota(db, f"reference-uploads:{workspace.id}", 30)
        db.commit()
    except ExtractionFailure as exc:
        db.rollback()
        raise HTTPException(429, "Reference upload limit reached. Try again tomorrow.") from exc
    try:
        pages, images = await run_in_threadpool(read_document, raw)
    except DocumentError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not any(p["text"].strip() for p in pages):
        raise HTTPException(422, "No readable text was found. Upload a clearer reference document.")
    db.execute(select(Workspace).where(Workspace.id == workspace.id).with_for_update()).scalar_one()
    existing = db.scalar(
        select(CompanyDocument)
        .where(CompanyDocument.workspace_id == workspace.id, CompanyDocument.sha256 == digest)
        .execution_options(populate_existing=True)
    )
    if existing and not existing.archived:
        return document_view(existing)
    if (
        db.scalar(
            select(func.count())
            .select_from(CompanyDocument)
            .where(
                CompanyDocument.workspace_id == workspace.id, CompanyDocument.archived.is_(False)
            )
        )
        >= 20
    ):
        raise HTTPException(409, "Reference library is full. Archive a document first.")
    filename = re.sub(r"[^a-zA-Z0-9.() -]", "_", file.filename or "reference.pdf")[:180]
    document = existing or CompanyDocument(
        id=uid(),
        workspace_id=workspace.id,
        filename=filename,
        sha256=digest,
        uploaded_by=workspace.current_member.name,
    )
    document.object_key = f"{workspace.id}/documents/{document.id}/source.pdf"
    document.page_data, document.archived = pages, False
    await run_in_threadpool(storage.put, document.object_key, raw, "application/pdf")
    for index, image in enumerate(images, 1):
        await run_in_threadpool(
            storage.put, f"{workspace.id}/documents/{document.id}/{index}.png", image, "image/png"
        )
    db.add(document)
    db.commit()
    return document_view(document)


def owned_document(db, workspace, document_id):
    document = db.get(CompanyDocument, document_id)
    if not document or document.workspace_id != workspace.id or document.archived:
        raise HTTPException(404, "Reference document not found.")
    return document


@router.get("/documents/{document_id}/source")
def document_source(document_id: str, workspace=Depends(session), db=Depends(database)):
    document = owned_document(db, workspace, document_id)
    return Response(
        storage.get(document.object_key),
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{document.filename}"'},
    )


@router.get("/documents/{document_id}/pages/{page}")
def document_page(document_id: str, page: int, workspace=Depends(session), db=Depends(database)):
    document = owned_document(db, workspace, document_id)
    if not 1 <= page <= len(document.page_data):
        raise HTTPException(404, "Page not found.")
    return Response(
        storage.get(f"{workspace.id}/documents/{document.id}/{page}.png"), media_type="image/png"
    )


@router.delete("/documents/{document_id}", status_code=204)
def archive_document(document_id: str, workspace=Depends(mutation), db=Depends(database)):
    db.execute(select(Workspace).where(Workspace.id == workspace.id).with_for_update()).scalar_one()
    document = owned_document(db, workspace, document_id)
    document.archived = True
    db.commit()
    return Response(status_code=204)
