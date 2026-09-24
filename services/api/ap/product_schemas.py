from typing import Literal

from pydantic import Field, field_validator

from .schemas import InvoiceRow, POResponse, StrictModel


class ProfileUpdate(StrictModel):
    name: str = Field(min_length=2, max_length=100)
    email: str = Field(max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

    @field_validator("name", "email")
    @classmethod
    def clean(cls, value):
        value = value.strip()
        if len(value) < 2:
            raise ValueError("Enter a name and email address.")
        return value


class CompanyUpdate(StrictModel):
    name: str = Field(min_length=2, max_length=120)
    address: str = Field(default="", max_length=500)
    ai_assistance: bool = True

    @field_validator("name")
    @classmethod
    def clean(cls, value):
        if len(value.strip()) < 2:
            raise ValueError("Enter the company name.")
        return value.strip()


class InviteRequest(StrictModel):
    email: str = Field(max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    role: Literal["reviewer", "viewer"] = "reviewer"


class InviteToken(StrictModel):
    token: str = Field(min_length=32, max_length=100)


class AcceptInvite(InviteToken):
    name: str = Field(min_length=2, max_length=100)

    @field_validator("name")
    @classmethod
    def clean(cls, value):
        if len(value.strip()) < 2:
            raise ValueError("Enter your name.")
        return value.strip()


class SupplierResponse(StrictModel):
    id: str
    name: str
    identifier: str
    active: bool
    invoice_count: int
    invoice_value: str
    needs_attention: int
    approved_value: str
    committed_value: str
    open_orders: int


class SupplierDetail(StrictModel):
    supplier: SupplierResponse
    invoices: list[InvoiceRow]
    orders: list[POResponse]


class DocumentResponse(StrictModel):
    id: str
    filename: str
    pages: int
    uploaded_by: str
    created_at: str


class MemberResponse(StrictModel):
    id: str
    name: str
    email: str
    role: str


class InvitationResponse(StrictModel):
    id: str
    email: str
    role: str
    expires_at: str


class TeamResponse(StrictModel):
    members: list[MemberResponse]
    invitations: list[InvitationResponse]


class InviteCreated(InvitationResponse):
    url: str


class InvitePreview(StrictModel):
    company: str
    email: str
    role: str
    expires_at: str
