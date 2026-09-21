"""Run inside the API container after evaluation; writes no secrets or session tokens."""

import json
from decimal import Decimal, InvalidOperation
from pathlib import Path

from ap.db import Decision, Run, Session
from sqlalchemy import select

path = Path("docs/evaluation-release.json")
report = json.loads(path.read_text())
labels = {c["file"]: c for c in json.loads(Path("fixtures/manifest.json").read_text())["cases"]}
input_tokens, output_tokens, models = 0, 0, set()
financial_checks, financial_errors = 0, 0


def number(value):
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


with Session() as db:
    for record in report["results"]:
        run = db.get(Run, record["run_id"])
        record["usage"] = run.usage
        record["actual_model"] = run.model
        models.add(run.model)
        input_tokens += run.usage.get("input_tokens", 0)
        output_tokens += run.usage.get("output_tokens", 0)
        decision = db.scalar(select(Decision).where(Decision.run_id == run.id))
        data = decision.extraction if decision else {}
        expected = labels[record["file"]]
        pairs = [
            ("vendor_identifier", expected["identifier"], data.get("vendor_identifier")),
            ("po_reference", expected["po"], data.get("po_reference")),
            ("line_count", 2 if expected.get("multipage") else 1, len(data.get("lines", []))),
        ]
        quantities = [number(line.get("quantity")) for line in data.get("lines", [])]
        total_quantity = (
            sum(quantities) if quantities and all(q is not None for q in quantities) else None
        )
        pairs.append(("aggregate_quantity", number(expected["quantity"]), total_quantity))
        for index, line in enumerate(data.get("lines", [])):
            pairs.extend(
                [
                    (f"lines.{index}.sku", expected["sku"], line.get("sku")),
                    (f"lines.{index}.unit", expected["unit"], line.get("unit")),
                    (
                        f"lines.{index}.unit_price",
                        number(expected["price"]),
                        number(line.get("unit_price")),
                    ),
                ]
            )
        record["financial_extraction_errors"] = [
            {
                "field": field,
                "expected": str(expected_value)
                if isinstance(expected_value, Decimal)
                else expected_value,
                "actual": str(actual) if isinstance(actual, Decimal) else actual,
            }
            for field, expected_value, actual in pairs
            if expected_value != actual
        ]
        financial_checks += len(pairs)
        financial_errors += len(record["financial_extraction_errors"])
report["actual_models"] = sorted(m for m in models if m)
report["token_usage"] = {
    "input": input_tokens,
    "output": output_tokens,
    "scope": "20 measured invoices; prerequisite, browser and development calls excluded",
}
report["estimated_cost"] = None
report["additional_financial_field_audit"] = {
    "checks": financial_checks,
    "errors": financial_errors,
    "scope": "Vendor identifier, PO reference, line count, aggregate quantity, each SKU/unit/unit price; no model re-query",
}
report["cost_note"] = "Not estimated. Token usage is measured; no dated price basis was applied."
path.write_text(json.dumps(report, indent=2), encoding="utf-8")
print(
    json.dumps(
        {
            "models": report["actual_models"],
            "tokens": report["token_usage"],
            "samples": report["samples"],
            "correct": report["correct"],
            "false_automatic_approvals": report["false_automatic_approvals"],
        }
    )
)
