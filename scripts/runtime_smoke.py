"""Exercise a new PDF through the real Next proxy; save restart credentials locally only."""

import argparse
import hashlib
import io
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / ".local" / "runtime-smoke-session.json"
REPORT = ROOT / "docs" / "runtime-smoke.json"
BASE = "http://localhost:3000/api"


def generated_pdf():
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=(612, 792))
    reference = "SMOKE-" + uuid4().hex[:10].upper()
    rows = [
        "INVOICE | Alder Office Supply",
        "Supplier ID: ALDER-001",
        "Bill to: Northstar Studio",
        f"Invoice number: {reference}",
        "Invoice date: 2026-09-15",
        "Purchase order: PO-1038",
        "Currency: USD",
        "SKU / Description / Quantity / Unit / Unit price / Discount / Line total",
        "PAPER-A4 / Copy paper, case / 7 / case / 100.00 / 0.00 / 700.00",
        "Subtotal USD: 700.00",
        "Header discount USD: 0.00",
        "Shipping USD: 0.00",
        "Tax exclusive. Tax rate: 0%. Tax USD: 0.00",
        "Total due USD: 700.00",
        "Synthetic invoice generated during runtime verification.",
    ]
    for index, line in enumerate(rows):
        pdf.setFont("Helvetica", 10 if index else 17)
        pdf.drawString(36, 745 - 36 * index, line)
    pdf.save()
    return reference, output.getvalue()


def get_json(client, path):
    response = client.get(path)
    response.raise_for_status()
    return response.json()


def first_stream_event(client, invoice_id, after=0):
    started = time.monotonic()
    with client.stream(
        "GET", f"/invoices/{invoice_id}/events", headers={"Last-Event-ID": str(after)}
    ) as response:
        response.raise_for_status()
        assert response.headers["content-type"].startswith("text/event-stream")
        for line in response.iter_lines():
            if line.startswith("id: "):
                return int(line[4:]), round(time.monotonic() - started, 3)
    raise AssertionError("SSE connection closed before a persisted event arrived")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--after-restart", action="store_true")
    args = parser.parse_args()
    with httpx.Client(
        base_url=BASE, headers={"origin": "http://localhost:3000"}, timeout=60
    ) as client:
        if args.after_restart:
            saved = json.loads(PRIVATE.read_text())
            client.cookies.update(saved["cookies"])
            invoice_id = saved["invoice_id"]
            current = get_json(client, f"/invoices/{invoice_id}")
            assert current["decision"]["id"] == saved["decision_id"]
            assert current["decision"]["comparison"]["remaining_after"] == "4300.00"
            source = client.get(f"/invoices/{invoice_id}/source")
            source.raise_for_status()
            assert hashlib.sha256(source.content).hexdigest() == saved["sha256"]
            report = json.loads(REPORT.read_text())
            report["restart_persistence"] = (
                "passed: same session, decision, PO balance and source SHA-256 after API/worker/Redis restart"
            )
            report["restart_checked_at"] = datetime.now(UTC).isoformat()
        else:
            response = client.post("/session")
            response.raise_for_status()
            client.headers["x-csrf-token"] = response.json()["csrf"]
            reference, document = generated_pdf()
            uploaded = client.post(
                "/invoices", files={"file": ("independent-smoke.pdf", document, "application/pdf")}
            )
            uploaded.raise_for_status()
            invoice_id = uploaded.json()["id"]
            first_id, first_seconds = first_stream_event(client, invoice_id)
            started = time.monotonic()
            while time.monotonic() - started < 300:
                current = get_json(client, f"/invoices/{invoice_id}")
                if current["run"]["state"] in ("COMPLETED", "FAILED"):
                    break
                time.sleep(1)
            assert current["invoice"]["outcome"] == "APPROVED", (
                current["run"]["error"] or current["decision"]["summary"]
            )
            assert current["extraction"]["invoice_number"] == reference
            assert current["decision"]["comparison"]["remaining_after"] == "4300.00"
            resumed_id, resumed_seconds = first_stream_event(client, invoice_id, first_id)
            assert resumed_id > first_id
            same = client.post(
                "/invoices", files={"file": ("new-name.pdf", document, "application/pdf")}
            )
            same.raise_for_status()
            assert same.json() == {"id": invoice_id, "existing": True}
            exported = get_json(client, f"/invoices/{invoice_id}/export")
            sha = hashlib.sha256(document).hexdigest()
            assert exported["provenance"]["document_sha256"] == sha
            assert exported["provenance"]["decisions"][0]["model"] == "gpt-4.1-mini-2025-04-14"
            assert client.get(f"/invoices/{invoice_id}/source").content == document
            page = client.get(f"/invoices/{invoice_id}/pages/1")
            assert page.status_code == 200 and page.content.startswith(b"\x89PNG")
            with httpx.Client(
                base_url=BASE, headers={"origin": "http://localhost:3000"}
            ) as stranger:
                stranger_session = stranger.post("/session")
                stranger_session.raise_for_status()
                stranger.headers["x-csrf-token"] = stranger_session.json()["csrf"]
                for suffix in ("", "/source", "/pages/1", "/events", "/export"):
                    assert stranger.get(f"/invoices/{invoice_id}{suffix}").status_code == 404
                assert (
                    stranger.post(
                        f"/invoices/{invoice_id}/retry", json={"expected_revision": 1}
                    ).status_code
                    == 404
                )
            PRIVATE.parent.mkdir(exist_ok=True)
            PRIVATE.write_text(
                json.dumps(
                    {
                        "cookies": dict(client.cookies),
                        "invoice_id": invoice_id,
                        "decision_id": current["decision"]["id"],
                        "sha256": sha,
                    }
                ),
                encoding="utf-8",
            )
            report = {
                "checked_at": datetime.now(UTC).isoformat(),
                "base_url": BASE,
                "new_nonpreset_pdf": "APPROVED",
                "expected_total": "700.00",
                "remaining_after": "4300.00",
                "source_and_render": "passed",
                "same_file_idempotency": "passed",
                "export_provenance": "passed",
                "cross_session_routes": "passed: detail, source, page, events, export, retry",
                "sse_first_event_seconds": first_seconds,
                "sse_resume_seconds": resumed_seconds,
                "sse_last_event_id": "passed: strictly later persisted event through Next proxy",
                "restart_persistence": "not yet checked",
            }
        REPORT.parent.mkdir(exist_ok=True)
        REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report))


if __name__ == "__main__":
    main()
