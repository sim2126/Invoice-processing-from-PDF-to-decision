import hashlib
import secrets
from datetime import timedelta
from decimal import Decimal

from sqlalchemy.dialects.postgresql import insert

from .config import POLICY_VERSION, settings
from .db import PO, Commitment, Member, Policy, Vendor, Workspace, now


def seed_workspace(db):
    token = secrets.token_urlsafe(32)
    workspace = Workspace(
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
        csrf=secrets.token_urlsafe(32),
        expires_at=now() + timedelta(hours=settings.session_hours),
    )
    db.add(workspace)
    db.flush()
    db.add(
        Member(
            workspace_id=workspace.id,
            name="Prabhakar Kumar",
            email="prabhakar@example.com",
            role="owner",
            token_hash=workspace.token_hash,
            csrf=workspace.csrf,
        )
    )
    db.execute(
        insert(Policy)
        .values(
            version=POLICY_VERSION,
            rules={
                "rounding": "ROUND_HALF_UP",
                "arithmetic_tolerance": "0.01",
                "unit_price_relative": "0.01",
                "unit_price_absolute": "1.00",
                "matching": "Two-way",
                "currency": "USD",
                "approval": "Accepted commitment; not payment",
            },
        )
        .on_conflict_do_nothing()
    )
    vendors = {}
    for name, identifier, aliases, active in [
        ("Alder Office Supply", "ALDER-001", ["Alder Office", "Alder Office Supply LLC"], True),
        ("Meridian Creative", "MERIDIAN-002", ["Meridian Creative Studio"], True),
        ("Fieldwork Equipment", "FIELD-003", ["Fieldwork Equipment Co."], True),
        ("Harbor Services", "HARBOR-004", ["Harbor Services LLC"], False),
    ]:
        v = Vendor(
            workspace_id=workspace.id,
            name=name,
            identifier=identifier,
            aliases=aliases,
            active=active,
        )
        db.add(v)
        db.flush()
        vendors[identifier] = v
    orders = [
        (
            "PO-1038",
            "ALDER-001",
            "Office refresh · September",
            "5000.00",
            "PAPER-A4",
            "Copy paper, case",
            "100.00",
            "50",
            "case",
        ),
        (
            "PO-1042",
            "ALDER-001",
            "Workspace essentials",
            "10000.00",
            "PAPER-A4",
            "Copy paper, case",
            "100.00",
            "100",
            "case",
        ),
        (
            "PO-1088",
            "MERIDIAN-002",
            "Brand studio · September",
            "8000.00",
            "DESIGN-HR",
            "Design services",
            "100.00",
            "80",
            "hour",
        ),
        (
            "PO-1091",
            "MERIDIAN-002",
            "Product studio · September",
            "8000.00",
            "DESIGN-HR",
            "Design services",
            "100.00",
            "80",
            "hour",
        ),
        (
            "PO-1103",
            "FIELD-003",
            "Equipment replenishment",
            "12000.00",
            "MONITOR-27",
            "27 inch monitor",
            "300.00",
            "40",
            "unit",
        ),
        (
            "PO-0999",
            "ALDER-001",
            "Closed office order",
            "2000.00",
            "PAPER-A4",
            "Copy paper, case",
            "100.00",
            "20",
            "case",
        ),
    ]
    for ref, vendor, desc, ceiling, sku, item, price, quantity, unit in orders:
        po = PO(
            workspace_id=workspace.id,
            vendor_id=vendors[vendor].id,
            reference=ref,
            description=desc,
            ceiling=Decimal(ceiling),
            status="CLOSED" if ref == "PO-0999" else "ACTIVE",
            lines=[
                {
                    "sku": sku,
                    "description": item,
                    "aliases": [item],
                    "unit_price": price,
                    "quantity": quantity,
                    "unit": unit,
                }
            ],
        )
        db.add(po)
        db.flush()
        if ref == "PO-1042":
            db.add(
                Commitment(
                    workspace_id=workspace.id,
                    po_id=po.id,
                    vendor_id=po.vendor_id,
                    identity="ald-0600",
                    invoice_date="2026-09-01",
                    currency="USD",
                    amount=Decimal("6000"),
                    quantities={sku: "60"},
                    historical=True,
                )
            )
    return workspace, token
