import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .config import settings


def now() -> datetime:
    return datetime.now(UTC)


def uid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


class Workspace(Base):
    __tablename__ = "workspace"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    uploads: Mapped[int] = mapped_column(default=0)


class Policy(Base):
    __tablename__ = "policy"
    version: Mapped[str] = mapped_column(String(30), primary_key=True)
    rules: Mapped[dict] = mapped_column(JSON)


class Vendor(Base):
    __tablename__ = "vendor"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspace.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    identifier: Mapped[str] = mapped_column(String(80))
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    active: Mapped[bool] = mapped_column(default=True)
    __table_args__ = (UniqueConstraint("workspace_id", "identifier"),)


class PO(Base):
    __tablename__ = "purchase_order"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspace.id"), index=True)
    vendor_id: Mapped[str] = mapped_column(ForeignKey("vendor.id"))
    reference: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(200))
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    status: Mapped[str] = mapped_column(String(20), default="ACTIVE")
    ceiling: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    lines: Mapped[list] = mapped_column(JSON)
    __table_args__ = (UniqueConstraint("workspace_id", "reference"), CheckConstraint("ceiling > 0"))


class Invoice(Base):
    __tablename__ = "invoice"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspace.id"), index=True)
    filename: Mapped[str] = mapped_column(String(200))
    sha256: Mapped[str] = mapped_column(String(64))
    object_key: Mapped[str] = mapped_column(String(200))
    pages: Mapped[int] = mapped_column(default=1)
    page_data: Mapped[list] = mapped_column(JSON, default=list)
    revision: Mapped[int] = mapped_column(default=1)
    current_run: Mapped[str | None] = mapped_column(String(36))
    current_decision: Mapped[str | None] = mapped_column(String(36))
    human_touched: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    __table_args__ = (UniqueConstraint("workspace_id", "sha256"),)


class Revision(Base):
    __tablename__ = "revision"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    invoice_id: Mapped[str] = mapped_column(ForeignKey("invoice.id"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    extraction: Mapped[dict | None] = mapped_column(JSON)
    selections: Mapped[dict] = mapped_column(JSON, default=dict)
    provenance: Mapped[dict] = mapped_column(JSON, default=dict)
    __table_args__ = (UniqueConstraint("invoice_id", "number"),)


class Run(Base):
    __tablename__ = "run"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    invoice_id: Mapped[str] = mapped_column(ForeignKey("invoice.id"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(20), default="QUEUED")
    attempt: Mapped[int] = mapped_column(default=0)
    attempt_token: Mapped[str | None] = mapped_column(String(36))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dispatch_count: Mapped[int] = mapped_column(default=0)
    retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(String(100))
    usage: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (CheckConstraint("state IN ('QUEUED','RUNNING','COMPLETED','FAILED')"),)


class Decision(Base):
    __tablename__ = "decision"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    invoice_id: Mapped[str] = mapped_column(ForeignKey("invoice.id"), index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("run.id"), unique=True)
    revision: Mapped[int] = mapped_column(Integer)
    outcome: Mapped[str] = mapped_column(String(20))
    policy_version: Mapped[str] = mapped_column(ForeignKey("policy.version"))
    document_hash: Mapped[str] = mapped_column(String(64))
    schema_version: Mapped[str] = mapped_column(String(30))
    prompt_version: Mapped[str] = mapped_column(String(30))
    model: Mapped[str] = mapped_column(String(100))
    extraction: Mapped[dict] = mapped_column(JSON)
    checks: Mapped[list] = mapped_column(JSON)
    summary: Mapped[str] = mapped_column(Text)
    next_action: Mapped[str] = mapped_column(Text)
    owner: Mapped[str] = mapped_column(String(80))
    vendor_id: Mapped[str | None] = mapped_column(ForeignKey("vendor.id"))
    po_id: Mapped[str | None] = mapped_column(ForeignKey("purchase_order.id"))
    comparison: Mapped[dict] = mapped_column(JSON, default=dict)
    duplicate_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    __table_args__ = (CheckConstraint("outcome IN ('APPROVED','NEEDS_REVIEW','BLOCKED')"),)


class Commitment(Base):
    __tablename__ = "commitment"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspace.id"), index=True)
    po_id: Mapped[str] = mapped_column(ForeignKey("purchase_order.id"), index=True)
    invoice_id: Mapped[str | None] = mapped_column(ForeignKey("invoice.id"), unique=True)
    vendor_id: Mapped[str] = mapped_column(ForeignKey("vendor.id"))
    identity: Mapped[str] = mapped_column(String(200))
    invoice_date: Mapped[str] = mapped_column(String(40))
    currency: Mapped[str] = mapped_column(String(3))
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    quantities: Mapped[dict] = mapped_column(JSON)
    historical: Mapped[bool] = mapped_column(default=False)
    __table_args__ = (
        UniqueConstraint("workspace_id", "vendor_id", "identity"),
        CheckConstraint("amount > 0"),
    )


class Event(Base):
    __tablename__ = "run_event"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("run.id"), index=True)
    stage: Mapped[str] = mapped_column(String(40))
    state: Mapped[str] = mapped_column(String(20))
    message: Mapped[str] = mapped_column(Text)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Audit(Base):
    __tablename__ = "audit"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    invoice_id: Mapped[str] = mapped_column(ForeignKey("invoice.id"), index=True)
    run_id: Mapped[str | None] = mapped_column(String(36))
    actor: Mapped[str] = mapped_column(String(80))
    action: Mapped[str] = mapped_column(String(50))
    revision: Mapped[int] = mapped_column(Integer)
    policy_version: Mapped[str] = mapped_column(String(30))
    before: Mapped[dict] = mapped_column(JSON, default=dict)
    after: Mapped[dict] = mapped_column(JSON, default=dict)
    reason: Mapped[str] = mapped_column(Text)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Quota(Base):
    __tablename__ = "quota"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    count: Mapped[int] = mapped_column(default=0)


engine = create_engine(settings.database_url, pool_pre_ping=True)
Session = sessionmaker(engine, expire_on_commit=False)
