"""Live PDF evaluation via normal upload endpoints; labels never enter runtime extraction."""

import argparse
import json
import statistics
import time
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]


def await_decision(client, invoice_id):
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        response = client.get(f"/invoices/{invoice_id}")
        response.raise_for_status()
        data = response.json()
        if data["run"]["state"] in ("COMPLETED", "FAILED"):
            return data
        time.sleep(1)
    raise TimeoutError("Invoice did not settle in five minutes")


def upload(client, filename):
    source = ROOT / "fixtures" / "pdfs" / filename
    response = client.post(
        "/invoices", files={"file": (filename, source.read_bytes(), "application/pdf")}
    )
    response.raise_for_status()
    return await_decision(client, response.json()["id"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://localhost:8005")
    parser.add_argument("--set", choices=["hero", "development", "release"], default="hero")
    args = parser.parse_args()
    (ROOT / "docs").mkdir(exist_ok=True)
    manifest = json.loads((ROOT / "fixtures/manifest.json").read_text())
    cases = (
        manifest["cases"][:5]
        if args.set == "hero"
        else [c for c in manifest["cases"] if not c.get("heldout")]
        if args.set == "development"
        else manifest["cases"]
    )
    rows = []
    for case in cases:
        with httpx.Client(
            base_url=args.base, headers={"origin": "http://localhost:3000"}, timeout=60
        ) as client:
            session = client.post("/session")
            session.raise_for_status()
            client.headers["x-csrf-token"] = session.json()["csrf"]
            if case.get("prerequisite"):
                prerequisite = upload(client, case["prerequisite"])
                if prerequisite["invoice"]["outcome"] != "APPROVED":
                    print("Prerequisite did not approve:", case["prerequisite"], flush=True)
            started = time.monotonic()
            data = upload(client, case["file"])
            elapsed = time.monotonic() - started
            actual = data["invoice"]["outcome"] or data["run"]["state"]
            extraction = data.get("extraction") or {}
            expected_critical = {
                "vendor_name": case["vendor"],
                "invoice_number": case["number"],
                "invoice_date": None if case["date"] == "09/10/2026" else case["date"],
                "currency": case["currency"],
                "total": case["total"],
            }
            errors = []
            for field, expected in expected_critical.items():
                observed = extraction.get(field)
                if field == "total":
                    from decimal import Decimal, InvalidOperation

                    try:
                        equal = Decimal(str(observed)) == Decimal(str(expected))
                    except InvalidOperation:
                        equal = False
                else:
                    equal = observed == expected
                if not equal:
                    errors.append({"field": field, "expected": expected, "actual": observed})
            record = {
                "file": case["file"],
                "expected": case["expected"],
                "actual": actual,
                "correct": actual == case["expected"],
                "heldout": bool(case.get("heldout")),
                "seconds": round(elapsed, 2),
                "critical_errors": errors,
                "invoice_id": data["invoice"]["id"],
                "run_id": data["run"]["id"],
                "issues": [
                    c
                    for c in (data.get("decision") or {}).get("checks", [])
                    if c["state"] != "passed"
                ],
                "comparison": (data.get("decision") or {}).get("comparison"),
                "failure": data["run"].get("error"),
            }
            rows.append(record)
            print(
                json.dumps(
                    {
                        "file": record["file"],
                        "actual": actual,
                        "correct": record["correct"],
                        "seconds": record["seconds"],
                        "issues": [c["code"] for c in record["issues"]],
                    }
                ),
                flush=True,
            )
            durations = sorted(r["seconds"] for r in rows)
            confusion = Counter((r["expected"], r["actual"]) for r in rows)
            report = {
                "label": args.set,
                "generated_at": datetime.now(UTC).isoformat(),
                "fixture_version": manifest["version"],
                "samples": len(rows),
                "correct": sum(r["correct"] for r in rows),
                "false_automatic_approvals": sum(
                    r["actual"] == "APPROVED" and r["expected"] != "APPROVED" for r in rows
                ),
                "critical_field_errors": sum(len(r["critical_errors"]) for r in rows),
                "median_seconds": statistics.median(durations),
                "p95_seconds": durations[max(0, int(len(durations) * 0.95 + 0.999) - 1)],
                "confusion_matrix": [
                    {"expected": k[0], "actual": k[1], "count": v} for k, v in confusion.items()
                ],
                "results": rows,
            }
            (ROOT / "docs" / f"evaluation-{args.set}.json").write_text(
                json.dumps(report, indent=2), encoding="utf-8"
            )
    raise SystemExit(0 if all(r["correct"] for r in rows) else 1)
