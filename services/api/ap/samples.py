"""Downloadable sample invoices that behave sensibly in a workspace with history.

Uploading them uses the normal intake. Samples whose invoice numbers collide
with the seeded history or the inbox (01–05, 08) are left out.
"""

import io
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import APIRouter, Depends, Response

from .auth import session
from .config import FIXTURES

router = APIRouter(prefix="/samples", dependencies=[Depends(session)])

SAMPLES = [
    (
        "06-readable-scan.pdf",
        "A scanned invoice with no text layer: Fieldwork Equipment FW-3100, two 27-inch "
        "monitors on PO-1103. The page is read with OCR. Expected: approved when every value "
        "is found on the scanned page; otherwise it waits for review.",
    ),
    (
        "07-multipage.pdf",
        "Fieldwork Equipment FW-3101 over two pages: one monitor on each page and the totals "
        "on the last page. Expected: approved, with both lines counted against PO-1103.",
    ),
    (
        "09-price-over.pdf",
        "Alder Office Supply ALD-1203 bills copy paper at $101.01 a case against $100.00 on "
        "PO-1042: $1.01 (1.01%) more, just over the 1% and $1.00 per-unit limits. Expected: "
        "needs review (price above tolerance).",
    ),
    (
        "10-missing-number.pdf",
        "An Alder Office Supply invoice with no invoice number, so a duplicate can't be ruled "
        "out. Expected: needs review (missing invoice number).",
    ),
    (
        "11-foreign-currency.pdf",
        "Alder Office Supply ALD-1204 is billed in euros against a US-dollar order. No "
        "exchange rate is applied. Expected: needs review.",
    ),
    (
        "12-ambiguous-date.pdf",
        "Alder Office Supply ALD-1205 prints its date as 09/10/2026, which could be "
        "10 September or 9 October. Tickmark doesn't guess. Expected: needs review.",
    ),
    (
        "13-inclusive-tax.pdf",
        "Fieldwork Equipment FW-3102 prints prices that include 10% tax: $330.00 a monitor "
        "is $300.00 net, the order price, plus $30.00 tax ($60.00 for both). Prices are "
        "compared net of tax; the order is charged the full $660.00. Expected: approved.",
    ),
    (
        "14-closed-order.pdf",
        "Alder Office Supply ALD-1206 bills PO-0999, which is closed. Expected: blocked.",
    ),
    (
        "15-injection.pdf",
        "Alder Office Supply ALD-1207 contains a line telling the reader to approve it and "
        "override all limits. That text is ignored: the invoice is decided by the same checks "
        "as any other. Expected: approved, because it is otherwise correct.",
    ),
    (
        "18-heldout-discount.pdf",
        "Alder Office Supply ALD-H003: eight cases with a $50.00 discount and $20.00 "
        "shipping, total $770.00. Expected: approved.",
    ),
    (
        "20-heldout-credit.pdf",
        "Alder Office Supply ALD-H005 is a credit note for -$1,200.00, not a bill. Credit "
        "notes follow a separate process. Expected: needs review.",
    ),
]

README = (
    "Tickmark sample invoices\n"
    "========================\n\n"
    "Fictional invoices billed to Juniper Labs by suppliers already in your workspace.\n"
    "Upload any of them with Add invoices: each goes through the same checks as every\n"
    "other invoice, against your workspace's current order balances. Uploading the same\n"
    "file again opens the original invoice instead of adding it twice. Outcomes assume\n"
    "the extracted values match what is printed.\n\n"
    + "\n\n".join(f"{name}\n  {text}" for name, text in SAMPLES)
    + "\n\nApproval reserves budget on the order for payment preparation. It does not pay\n"
    "the supplier.\n"
)


@router.get("/pack")
def sample_pack():
    output = io.BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("README.txt", README)
        for name, _ in SAMPLES:
            archive.write(FIXTURES / "pdfs" / name, arcname=name)
    return Response(
        output.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="tickmark-sample-invoices.zip"'},
    )
