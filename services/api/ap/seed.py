import hashlib
import logging
import secrets
from datetime import timedelta
from decimal import Decimal

from sqlalchemy.dialects.postgresql import insert

from . import history as seeded_history
from .config import POLICY_VERSION, settings
from .db import PO, Commitment, Member, Policy, Vendor, Workspace, now, uid

logger = logging.getLogger(__name__)

# (name, identifier, aliases, active)
VENDORS = [
    ("Alder Office Supply", "ALDER-001", ["Alder Office", "Alder Office Supply LLC"], True),
    ("Meridian Creative", "MERIDIAN-002", ["Meridian Creative Studio"], True),
    ("Fieldwork Equipment", "FIELD-003", ["Fieldwork Equipment Co."], True),
    ("Harbor Services", "HARBOR-004", ["Harbor Services LLC"], False),
    ("Coastline Freight", "COAST-005", ["Coastline Freight Co.", "Coastline Logistics"], True),
    ("Brightwave Cloud", "BRIGHT-006", ["Brightwave", "Brightwave Cloud Inc."], True),
    ("Pinecrest Facilities", "PINE-007", ["Pinecrest Facilities Services"], True),
    ("Lumen Print Co.", "LUMEN-008", ["Lumen Print", "Lumen Printing Company"], True),
]
# (reference, vendor, description, ceiling, sku, item, unit price, quantity, unit, status)
ORDERS = [
    ("PO-1038", "ALDER-001", "Office refresh · September", "5000.00")
    + ("PAPER-A4", "Copy paper, case", "100.00", "50", "case", "ACTIVE"),
    ("PO-1042", "ALDER-001", "Workspace essentials", "10000.00")
    + ("PAPER-A4", "Copy paper, case", "100.00", "100", "case", "ACTIVE"),
    ("PO-1088", "MERIDIAN-002", "Brand studio · September", "8000.00")
    + ("DESIGN-HR", "Design services", "100.00", "80", "hour", "ACTIVE"),
    ("PO-1091", "MERIDIAN-002", "Product studio · September", "8000.00")
    + ("DESIGN-HR", "Design services", "100.00", "80", "hour", "ACTIVE"),
    ("PO-1103", "FIELD-003", "Equipment replenishment", "12000.00")
    + ("MONITOR-27", "27-inch monitor", "300.00", "40", "unit", "ACTIVE"),
    ("PO-0999", "ALDER-001", "Office order · August", "2000.00")
    + ("PAPER-A4", "Copy paper, case", "100.00", "20", "case", "CLOSED"),
    ("PO-1120", "COAST-005", "Freight · Q4", "9000.00")
    + ("FREIGHT-LTL", "LTL shipment, Portland", "450.00", "20", "shipment", "ACTIVE"),
    ("PO-1124", "BRIGHT-006", "Cloud seats · annual", "14400.00")
    + ("SEAT-PRO", "Pro seat, monthly", "40.00", "360", "seat-month", "ACTIVE"),
    ("PO-1131", "PINE-007", "Office cleaning · Q4", "7200.00")
    + ("CLEAN-WK", "Office cleaning, weekly", "600.00", "12", "week", "ACTIVE"),
    ("PO-1135", "LUMEN-008", "Launch print run", "4800.00")
    + ("PRINT-BRO", "Product brochure, A5", "1.20", "4000", "brochure", "ACTIVE"),
]
# Earlier spellings of an item still identify the same order line.
ITEM_ALIASES = {"MONITOR-27": ["27 inch monitor"]}


def seed_workspace(db, history: bool | None = None):
    """A new workspace: owner, policy, suppliers, orders and (by default) its history.

    Without history, PO-1042 keeps one synthetic $6,000 prior commitment so its
    $4,000 remaining baseline is unchanged. With history, the real invoices
    ALD-1101 and ALD-1144 account for that $6,000 instead.
    """
    history = settings.seed_history if history is None else history
    if history and not seeded_history.available():
        logger.warning("History fixtures are missing; seeding the workspace without history.")
        history = False
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
    vendors = {
        identifier: Vendor(
            id=uid(),
            workspace_id=workspace.id,
            name=name,
            identifier=identifier,
            aliases=aliases,
            active=active,
        )
        for name, identifier, aliases, active in VENDORS
    }
    db.add_all(vendors.values())
    db.flush()
    orders = []
    for ref, vendor, desc, ceiling, sku, item, price, quantity, unit, status in ORDERS:
        orders.append(
            PO(
                id=uid(),
                workspace_id=workspace.id,
                vendor_id=vendors[vendor].id,
                reference=ref,
                description=desc,
                ceiling=Decimal(ceiling),
                status=status,
                lines=[
                    {
                        "sku": sku,
                        "description": item,
                        "aliases": [item, *ITEM_ALIASES.get(sku, [])],
                        "unit_price": price,
                        "quantity": quantity,
                        "unit": unit,
                    }
                ],
            )
        )
    db.add_all(orders)
    db.flush()
    if history:
        seeded_history.seed_history(db, workspace.id, vendors.values(), orders)
    else:
        po = next(o for o in orders if o.reference == "PO-1042")
        db.add(
            Commitment(
                workspace_id=workspace.id,
                po_id=po.id,
                vendor_id=po.vendor_id,
                identity="ald-0600",
                invoice_date="2026-09-01",
                currency="USD",
                amount=Decimal("6000"),
                quantities={"PAPER-A4": "60"},
                historical=True,
            )
        )
    return workspace, token
