"""Read-only sample pairs; adding invoices and references uses the normal APIs."""

import io
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import APIRouter, Depends, HTTPException, Response

from .auth import session
from .config import ROOT

router = APIRouter(prefix="/follow-up-examples", dependencies=[Depends(session)])

FOLLOWUP_EXAMPLES = [
    {
        "id": "brand-assignment",
        "title": "A missing project assignment",
        "description": "Eight design hours could belong to either studio project. Maya supplies the assignment.",
        "file": "21-brand-assignment.pdf",
        "invoice_number": "MER-2201",
        "vendor": "Meridian Creative",
        "amount": "800.00",
        "expected_before": "Review required",
        "expected_after": "Approved",
        "reference_file": "21-brand-assignment-confirmation.pdf",
        "reference_title": "Project assignment from Maya Patel",
        "resolution": "The assignment links this invoice and supplier to PO-1088. AI can match the order and rerun the checks.",
    },
    {
        "id": "product-confirmation",
        "title": "A buyer confirms the project",
        "description": "Twelve design hours need the product team's confirmation of the correct order.",
        "file": "22-product-confirmation.pdf",
        "invoice_number": "MER-2202",
        "vendor": "Meridian Creative",
        "amount": "1200.00",
        "expected_before": "Review required",
        "expected_after": "Approved",
        "reference_file": "22-product-buyer-confirmation.pdf",
        "reference_title": "Buyer confirmation from Daniel Brooks",
        "resolution": "Daniel confirms PO-1091 for the product studio work. The invoice can proceed if the remaining checks pass.",
    },
    {
        "id": "office-delivery",
        "title": "A delivery identifies the order",
        "description": "Six cases of office paper arrived without a PO number on the invoice. Olivia confirms their allocation.",
        "file": "23-office-delivery.pdf",
        "invoice_number": "ALD-2203",
        "vendor": "Alder Office Supply",
        "amount": "600.00",
        "expected_before": "Review required",
        "expected_after": "Approved",
        "reference_file": "23-office-delivery-confirmation.pdf",
        "reference_title": "Delivery allocation from Olivia Chen",
        "resolution": "The delivery allocation explicitly connects this invoice to PO-1038 for the office refresh.",
    },
    {
        "id": "equipment-receipt",
        "title": "A receipt fills the missing reference",
        "description": "Two monitors have a clear receipt but no printed PO. Nora confirms the equipment order.",
        "file": "24-equipment-receipt.pdf",
        "invoice_number": "FW-2204",
        "vendor": "Fieldwork Equipment",
        "amount": "600.00",
        "expected_before": "Review required",
        "expected_after": "Approved",
        "reference_file": "24-equipment-receipt-confirmation.pdf",
        "reference_title": "Equipment receipt from Nora Reed",
        "resolution": "The receiving record assigns this invoice to PO-1103. Supplier, price, quantity and budget checks still run.",
    },
    {
        "id": "budget-shortfall",
        "title": "The order is right; the budget is short",
        "description": "Procurement identifies the order, but the $4,500 invoice exceeds its $4,000 remaining budget.",
        "file": "25-budget-shortfall.pdf",
        "invoice_number": "ALD-2205",
        "vendor": "Alder Office Supply",
        "amount": "4500.00",
        "expected_before": "Review required",
        "expected_after": "Review required",
        "reference_file": "25-budget-shortfall-confirmation.pdf",
        "reference_title": "Procurement confirmation from Maya Patel",
        "resolution": "AI can match PO-1042, but the amount and quantity still exceed what remains. Procurement must resolve the shortfall.",
    },
]


def example_for(example_id):
    example = next((item for item in FOLLOWUP_EXAMPLES if item["id"] == example_id), None)
    if not example:
        raise HTTPException(404, "Follow-up example not found.")
    return example


def example_file(example_id, kind, *, preview=False):
    example = example_for(example_id)
    filename = example["reference_file" if kind == "reference" else "file"]
    path = ROOT / "fixtures" / "pdfs" / filename
    return path.with_suffix(".preview.png") if preview else path


def file_response(example_id, kind, *, preview=False):
    path = example_file(example_id, kind, preview=preview)
    return Response(
        path.read_bytes(),
        media_type="image/png" if preview else "application/pdf",
        headers={} if preview else {"Content-Disposition": f'attachment; filename="{path.name}"'},
    )


@router.get("")
def examples():
    return FOLLOWUP_EXAMPLES


@router.get("/pack")
def example_pack():
    instructions = (
        "AP Review Desk - invoice follow-up examples\n\n"
        "These are fictional invoices and confirmations for demonstrating the real workflow.\n"
        "Start with a fresh workspace for the expected outcomes and original order balances.\n"
        "The five examples can be run together; their invoice numbers are distinct.\n\n"
        "1. Open Documents > Follow-up examples in the review desk.\n"
        "2. Preview the invoice, then start it (or upload its PDF normally).\n"
        "3. Open the completed review. The missing order remains unresolved and the AI\n"
        "   can prepare a follow-up draft asking for supporting information.\n"
        "4. Preview the paired confirmation. Add it to Company references only after\n"
        "   the first review, to demonstrate receiving a real supporting response.\n"
        "5. Return to the invoice and choose Ask AI to review. Inspect Sources used\n"
        "   and the new revision to see the supported match and rerun checks.\n\n"
        "Previewing or downloading a file does not upload it, send a message, or run AI.\n"
        "Adding a reference uses the normal reference upload API. A draft is never emailed.\n"
        "In real use, obtain the actual assignment or confirmation from the responsible team.\n\n"
        "Examples and expected outcomes:\n"
        + "\n".join(
            f"{item['file']} + {item['reference_file']}: "
            f"{item['expected_before']} -> {item['expected_after']}. {item['resolution']}"
            for item in FOLLOWUP_EXAMPLES
        )
        + "\n\nExpected outcomes depend on readable extraction, enabled AI assistance, and "
        "current workspace balances. Existing commitments still count.\n"
        "The fifth example deliberately stays in review: its confirmation supplies the "
        "PO, not extra budget or quantity. Approval means accepted commitment, not payment.\n"
        "All documents contain a synthetic-data footer; no real customers or transactions.\n"
    )
    output = io.BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("START-HERE.txt", instructions)
        for item in FOLLOWUP_EXAMPLES:
            for kind in ("invoice", "reference"):
                path = example_file(item["id"], kind)
                archive.write(path, arcname=path.name)
    return Response(
        output.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="ap-review-follow-up-examples.zip"'},
    )


@router.get("/{example_id}/invoice")
def invoice(example_id: str):
    return file_response(example_id, "invoice")


@router.get("/{example_id}/invoice/preview")
def invoice_preview(example_id: str):
    return file_response(example_id, "invoice", preview=True)


@router.get("/{example_id}/reference")
def reference(example_id: str):
    return file_response(example_id, "reference")


@router.get("/{example_id}/reference/preview")
def reference_preview(example_id: str):
    return file_response(example_id, "reference", preview=True)
