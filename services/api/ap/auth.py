import hashlib

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select

from .config import settings
from .db import Member, Session, Workspace, now
from .schemas import SessionResponse

DEFAULT_COMPANY = {"name": "Northstar Studio", "currency": "USD", "ai_assistance": True}


def database(request: Request):
    with Session() as db:
        if request.method == "GET":
            db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        yield db


def session(request: Request, db=Depends(database)):
    token = request.cookies.get("ap_session", "")
    member = db.scalar(
        select(Member).where(
            Member.token_hash == hashlib.sha256(token.encode()).hexdigest(), Member.active.is_(True)
        )
    )
    workspace = db.get(Workspace, member.workspace_id) if member else None
    if not workspace or workspace.expires_at <= now():
        raise HTTPException(
            401, "Your workspace session has expired. Start a fresh workspace to continue."
        )
    workspace.current_member = member
    return workspace


def check_origin(request):
    if request.headers.get("origin", "").rstrip("/") != settings.origin:
        raise HTTPException(403, "This action must be made from the review desk.")


def authenticated_mutation(request: Request, workspace=Depends(session)):
    check_origin(request)
    if request.headers.get("x-csrf-token") != workspace.current_member.csrf:
        raise HTTPException(403, "Refresh the page before trying this action again.")
    return workspace


def mutation(workspace=Depends(authenticated_mutation)):
    if workspace.current_member.role == "viewer":
        raise HTTPException(
            403, "Your role can view records. Ask a workspace owner for reviewer access."
        )
    return workspace


def owner(workspace=Depends(mutation)):
    if workspace.current_member.role != "owner":
        raise HTTPException(403, "Only the workspace owner can change company or team settings.")
    return workspace


def session_payload(workspace):
    member = workspace.current_member
    return SessionResponse(
        csrf=member.csrf,
        workspace=workspace.id[:8],
        expires_at=workspace.expires_at.isoformat(),
        extraction_ready=bool(settings.api_key and settings.model),
        max_bytes=settings.max_bytes,
        max_pages=settings.max_pages,
        user={"id": member.id, "name": member.name, "email": member.email, "role": member.role},
        company={**DEFAULT_COMPANY, **workspace.company},
    )
