from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Citation(StrictModel):
    field: str
    page: int | None
    quote: str | None
    raw: str | None


class Line(StrictModel):
    description: str | None
    sku: str | None
    quantity: str | None
    unit: str | None
    unit_price: str | None
    discount: str | None
    total: str | None


class Extraction(StrictModel):
    vendor_name: str | None
    vendor_identifier: str | None
    invoice_number: str | None
    invoice_date: str | None
    due_date: str | None
    po_reference: str | None
    currency: str | None
    subtotal: str | None
    header_discount: str | None
    shipping: str | None
    tax: str | None
    tax_rate: str | None
    total: str | None
    tax_treatment: Literal["exclusive", "inclusive", "none", "ambiguous"]
    document_kind: Literal["invoice", "credit_note", "other"]
    invoice_count: int
    po_references: list[str]
    lines: list[Line]
    evidence: list[Citation]
    warnings: list[str]


class Correction(StrictModel):
    field: str
    value: str = Field(max_length=200)
    page: int = Field(ge=1, le=10)
    source_text: str = Field(min_length=1, max_length=500)


class ReviewRequest(StrictModel):
    expected_revision: int = Field(ge=1)
    reason: str = Field(min_length=8, max_length=1000)
    vendor_id: str | None = None
    po_id: str | None = None
    corrections: list[Correction] = Field(default_factory=list, max_length=20)

    @field_validator("reason")
    @classmethod
    def meaningful_reason(cls, value):
        value = value.strip()
        if len(value) < 8:
            raise ValueError("Record a meaningful reason of at least 8 characters.")
        return value


class RetryRequest(StrictModel):
    expected_revision: int = Field(ge=1)


class Check(StrictModel):
    code: str
    title: str
    state: Literal["passed", "review", "blocked", "skipped"]
    message: str


class InvoiceRow(StrictModel):
    id: str
    filename: str
    reference: str | None
    vendor: str | None
    total: str | None
    currency: str | None
    po_reference: str | None
    execution: str
    outcome: str | None
    decision_applicable: bool
    summary: str
    created_at: str
    revision: int
    human_touched: bool


class QueueResponse(StrictModel):
    invoices: list[InvoiceRow]
    metrics: dict[str, int | str | None]
    scope: str


class SessionResponse(StrictModel):
    csrf: str
    workspace: str
    expires_at: str
    extraction_ready: bool
    max_bytes: int
    max_pages: int


class UploadResponse(StrictModel):
    id: str
    existing: bool


class EventResponse(StrictModel):
    id: int
    run_id: str
    stage: str
    state: str
    message: str
    at: str


class EvidenceResponse(Citation):
    bbox: list[float] | None
    method: str
    status: str
    label: str
    support: str | None = None


class Comparison(StrictModel):
    po_reference: str | None = None
    ceiling: str | None = None
    committed_before: str | None = None
    remaining_before: str | None = None
    remaining_after: str | None = None
    shortfall: str | None = None
    normalized: dict[str, str] | None = None
    lines: list[dict[str, str]] = Field(default_factory=list)


class RunResponse(StrictModel):
    id: str
    state: str
    attempt: int
    error: str | None
    started_at: str | None
    finished_at: str | None


class AuditResponse(StrictModel):
    id: str
    action: str
    actor: str
    reason: str
    before: dict
    after: dict
    revision: int
    run_id: str | None
    policy_version: str
    at: str


class VendorResponse(StrictModel):
    id: str
    name: str
    identifier: str
    active: bool
    aliases: list[str]


class POResponse(StrictModel):
    id: str
    vendor_id: str
    reference: str
    description: str
    ceiling: str
    currency: str
    status: str
    lines: list[dict[str, str | list[str]]]


class Candidates(StrictModel):
    vendors: list[VendorResponse]
    orders: list[POResponse]


class DecisionResponse(StrictModel):
    id: str
    run_id: str
    revision: int
    outcome: str
    summary: str
    next_action: str
    owner: str
    checks: list[Check]
    comparison: Comparison
    duplicate_id: str | None
    policy_version: str
    extraction: dict
    created_at: str


class DetailResponse(StrictModel):
    invoice: InvoiceRow
    pages: int
    run: RunResponse
    decision: DecisionResponse | None
    history: list[DecisionResponse]
    extraction: Extraction | None
    evidence: list[EvidenceResponse]
    events: list[EventResponse]
    audit: list[AuditResponse]
    candidates: Candidates
    policy: dict
