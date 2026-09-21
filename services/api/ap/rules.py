"""Pure, explicit financial policy. No network, floats or model decisions."""

import re
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from .schemas import Check

CENT = Decimal("0.01")
ZERO = Decimal("0")


def decimal(value) -> Decimal | None:
    if value is None or isinstance(value, (float, bool)):
        return None
    try:
        text = str(value).strip().replace(",", "").replace("$", "")
        if len(text) > 30 or not re.fullmatch(r"-?\d+(\.\d{1,6})?", text):
            return None
        result = Decimal(text)
        return result if result.is_finite() and abs(result) < Decimal("1000000000000") else None
    except (InvalidOperation, ValueError):
        return None


def money(value: Decimal) -> str:
    return str(value.quantize(CENT, rounding=ROUND_HALF_UP))


def usd(value: Decimal) -> str:
    return f"${value:,.2f}"


def identity(value: str | None) -> str:
    return " ".join((value or "").strip().casefold().split())


def weak_identity(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", identity(value))


def price_allowed(actual: Decimal, approved: Decimal) -> bool:
    if approved <= 0 or actual < 0:
        return False
    difference = actual - approved
    return difference <= 0 or (
        difference <= Decimal("1") and difference / approved <= Decimal("0.01")
    )


def vendor_candidates(data, vendors):
    identifier = identity(data.get("vendor_identifier"))
    name = identity(data.get("vendor_name"))
    exact = [v for v in vendors if identifier and identity(v["identifier"]) == identifier]
    if exact:
        return exact
    return [
        v for v in vendors if name and name in [identity(v["name"]), *map(identity, v["aliases"])]
    ]


def evaluate(data, evidence, vendors, orders, commitments, prior, selections, today: date):
    checks = []
    comparison = {}
    duplicate_id = None
    allocations = {}

    def add(code, title, state, message):
        checks.append(Check(code=code, title=title, state=state, message=message).model_dump())

    supported = (
        data.get("document_kind") == "invoice"
        and data.get("invoice_count") == 1
        and len(set(data.get("po_references", []))) <= 1
    )
    add(
        "scope",
        "Supported document",
        "passed" if supported else "review",
        "One invoice, one purchase order."
        if supported
        else "Credit notes, multiple invoices or multiple POs need a separate AP process.",
    )
    for warning in data.get("warnings", []):
        add("extraction_warning", "Document needs clarification", "review", warning)
    required = ["invoice_number", "invoice_date", "currency", "total"]
    if not data.get("vendor_name") and not data.get("vendor_identifier"):
        required.append("vendor_name")
    required.append("vendor_identifier" if data.get("vendor_identifier") else "vendor_name")
    for field in dict.fromkeys(required):
        ok = bool(data.get(field))
        add(
            "required_" + field,
            field.replace("_", " ").capitalize(),
            "passed" if ok else "review",
            "Required value is present."
            if ok
            else f"Confirm the missing {field.replace('_', ' ')} from the source.",
        )
    critical = [f for f in required if data.get(f)]
    critical += [
        f
        for f in ["po_reference", "subtotal", "header_discount", "shipping", "tax", "tax_rate"]
        if data.get(f) is not None
    ]
    for i, line in enumerate(data.get("lines", [])):
        critical += [
            f"lines.{i}.{f}"
            for f in ["quantity", "unit", "unit_price", "total", "discount"]
            if line.get(f) is not None
        ]
        critical.append(f"lines.{i}.sku" if line.get("sku") else f"lines.{i}.description")
    verified = {e["field"] for e in evidence if e.get("status") in ("observed", "reviewer")}
    missing = sorted(set(critical) - verified)
    add(
        "evidence",
        "Source evidence",
        "review" if missing else "passed",
        "Verify source evidence for: " + ", ".join(missing)
        if missing
        else "Decision-critical values are grounded in the document or a reasoned reviewer correction.",
    )
    raw_date = data.get("invoice_date")
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw_date or ""):
            raise ValueError
        invoice_date = date.fromisoformat(raw_date)
        valid_date = invoice_date <= today
        date_message = (
            "Invoice date is not in the future."
            if valid_date
            else "Confirm the future invoice date with the vendor."
        )
    except (ValueError, TypeError):
        valid_date = False
        date_message = "Confirm an unambiguous invoice date; do not assume a date format."
    add("date", "Invoice date", "passed" if valid_date else "review", date_message)
    add(
        "currency",
        "USD policy",
        "passed" if data.get("currency") == "USD" else "review",
        "Invoice is denominated in USD."
        if data.get("currency") == "USD"
        else "Confirm currency or route to the foreign-currency AP process. No exchange rate was applied.",
    )
    total = decimal(data.get("total"))
    add(
        "positive_total",
        "Positive invoice amount",
        "passed" if total is not None and total > 0 else "review",
        "Positive finite total."
        if total is not None and total > 0
        else "Zero, negative or invalid totals require the credit-note / AP review process.",
    )
    if total is not None and total != total.quantize(CENT, rounding=ROUND_HALF_UP):
        add(
            "precision",
            "USD amount precision",
            "review",
            "Invoice total must have at most two decimal places.",
        )

    matches = vendor_candidates(data, vendors)
    vendor = matches[0] if len(matches) == 1 else None
    if selections.get("vendor_id"):
        vendor = next((v for v in vendors if v["id"] == selections["vendor_id"]), None)
    add(
        "vendor",
        "Approved vendor",
        "review" if vendor is None else "passed" if vendor["active"] else "blocked",
        "Confirm the vendor against the approved register."
        if vendor is None
        else f"{vendor['name']} is {'active in' if vendor['active'] else 'inactive in'} the approved register.",
    )
    po = None
    candidates = []
    if vendor:
        candidates = [
            p
            for p in orders
            if p["vendor_id"] == vendor["id"]
            and p["currency"] == data.get("currency")
            and p["status"] == "ACTIVE"
        ]
        if selections.get("po_id"):
            po = next((p for p in orders if p["id"] == selections["po_id"]), None)
        elif data.get("po_reference"):
            po = next(
                (p for p in orders if identity(p["reference"]) == identity(data["po_reference"])),
                None,
            )
    if (
        po
        and vendor
        and (po["vendor_id"] != vendor["id"] or po["currency"] != data.get("currency"))
    ):
        add(
            "po",
            "Purchase order match",
            "review",
            "Purchase order vendor or currency conflicts with this invoice. Confirm purchase order.",
        )
        po = None
    elif po:
        add(
            "po",
            "Purchase order match",
            "passed" if po["status"] == "ACTIVE" else "blocked",
            f"{po['reference']} · {po['description']}"
            if po["status"] == "ACTIVE"
            else f"{po['reference']} is closed or cancelled. Contact procurement.",
        )
    else:
        add(
            "po",
            "Confirm purchase order",
            "review",
            f"{len(candidates)} supported purchase orders. Select the correct order and record why."
            if candidates
            else "No supported purchase order. Ask procurement to confirm the order.",
        )

    assumptions = []
    optional = {}
    for field in ["header_discount", "shipping", "tax"]:
        optional[field] = decimal(data.get(field)) if data.get(field) is not None else ZERO
        if data.get(field) is None:
            assumptions.append(field.replace("_", " "))
    line_sum = ZERO
    lines_valid = bool(data.get("lines"))
    treatment = data.get("tax_treatment")
    rate = decimal(data.get("tax_rate"))
    inclusive = treatment == "inclusive"
    inclusive_ok = (
        rate is not None
        and rate >= 0
        and rate <= 100
        and all((optional[x] or ZERO) == 0 for x in ["header_discount", "shipping"])
    )
    add(
        "tax_treatment",
        "Tax basis",
        "review" if treatment == "ambiguous" or (inclusive and not inclusive_ok) else "passed",
        "Confirm mixed or insufficiently stated tax treatment."
        if treatment == "ambiguous" or (inclusive and not inclusive_ok)
        else "Uniform stated inclusive rate used to derive net amounts."
        if inclusive
        else "Line amounts are net; stated tax is added once. No statutory tax validation.",
    )
    price_rows = []
    for index, line in enumerate(data.get("lines", [])):
        if line.get("discount") is None:
            assumptions.append(f"line {index + 1} discount")
        q, price, stated = [decimal(line.get(f)) for f in ["quantity", "unit_price", "total"]]
        disc = decimal(line.get("discount")) if line.get("discount") is not None else ZERO
        if (
            q is None
            or q <= 0
            or price is None
            or price < 0
            or stated is None
            or disc is None
            or disc < 0
            or stated < 0
        ):
            lines_valid = False
            add(
                f"line_{index}",
                f"Line {index + 1} arithmetic",
                "review",
                "Confirm positive quantity, non-negative amounts, unit price and line total.",
            )
            continue
        difference = abs(q * price - disc - stated)
        line_ok = difference <= CENT
        lines_valid &= line_ok
        add(
            f"line_{index}",
            f"Line {index + 1} arithmetic",
            "passed" if line_ok else "review",
            f"Quantity × price − line discount compared with stated total; difference {usd(difference)}.",
        )
        line_sum += stated
        net_price = price / (1 + rate / 100) if inclusive and inclusive_ok else price
        if po:
            line_matches = [
                p
                for p in po["lines"]
                if (line.get("sku") and identity(line["sku"]) == identity(p["sku"]))
                or (
                    not line.get("sku")
                    and identity(line.get("description"))
                    in [identity(p["description"]), *map(identity, p.get("aliases", []))]
                )
            ]
            matched = line_matches[0] if len(line_matches) == 1 else None
            if matched is None or identity(line.get("unit")) != identity(matched["unit"]):
                add(
                    f"line_match_{index}",
                    f"Line {index + 1} allocation",
                    "review",
                    "Confirm an exact SKU/approved line description and quantity unit. Bundled lines cannot be guessed.",
                )
            else:
                allocations[matched["sku"]] = allocations.get(matched["sku"], ZERO) + q
                approved_price = decimal(matched["unit_price"])
                ok = approved_price is not None and price_allowed(net_price, approved_price)
                add(
                    f"price_{index}",
                    f"Line {index + 1} unit price",
                    "passed" if ok else "review",
                    f"Invoice {usd(net_price)} / PO {usd(approved_price or ZERO)}. Upward tolerance requires both ≤1% and ≤$1 per unit.",
                )
                price_rows.append(
                    {
                        "sku": matched["sku"],
                        "description": matched["description"],
                        "unit": matched["unit"],
                        "invoice_quantity": str(q),
                        "invoice_price": money(net_price),
                        "po_price": matched["unit_price"],
                    }
                )
    if not data.get("lines"):
        add(
            "lines",
            "Itemised lines",
            "review",
            "Obtain itemised lines before allocating the invoice to a purchase order.",
        )
    valid_optional = all(v is not None and v >= 0 for v in optional.values())
    header_difference = None
    if lines_valid and total is not None and valid_optional:
        if inclusive and inclusive_ok:
            gross = line_sum
            net = (gross / (1 + rate / 100)).quantize(CENT, rounding=ROUND_HALF_UP)
            derived_tax = gross - net
            if data.get("tax") is not None and abs(optional["tax"] - derived_tax) > CENT:
                add(
                    "tax_amount",
                    "Inclusive tax amount",
                    "review",
                    "Stated tax conflicts with tax derived from the stated inclusive rate.",
                )
        else:
            net = line_sum - optional["header_discount"] + optional["shipping"]
            derived_tax = optional["tax"]
            gross = net + derived_tax
            if optional["header_discount"] > line_sum or net < 0:
                add(
                    "net_amount",
                    "Net amount",
                    "review",
                    "Header discount exceeds the line-net sum. Confirm the invoice or use the credit-note process.",
                )
            if data.get("tax_rate") is not None:
                rate_valid = rate is not None and 0 <= rate <= 100
                expected_tax = (
                    (line_sum - optional["header_discount"]) * rate / 100 if rate_valid else None
                )
                tax_ok = (
                    rate_valid
                    and (rate == 0 or optional["shipping"] == 0)
                    and abs(expected_tax - derived_tax) <= CENT
                )
                add(
                    "tax_rate_amount",
                    "Stated tax rate and amount",
                    "passed" if tax_ok else "review",
                    "Tax amount agrees with the stated rate on net lines after header discount."
                    if tax_ok
                    else "Confirm the stated tax rate, amount and taxable shipping basis. No statutory tax rule was assumed.",
                )
            if treatment == "none" and derived_tax != 0:
                add(
                    "zero_tax",
                    "No-tax declaration",
                    "review",
                    "The no-tax declaration conflicts with a nonzero tax amount.",
                )
        header_difference = abs(gross - total)
        comparison["normalized"] = {
            "net": money(net),
            "tax": money(derived_tax),
            "gross": money(gross),
        }
        add(
            "arithmetic",
            "Invoice totals reconcile",
            "passed" if header_difference <= CENT else "review",
            f"Calculated {usd(gross)} / stated {usd(total)}; difference {usd(header_difference)}. "
            + (
                "Within the $0.01 rounding allowance."
                if header_difference <= CENT
                else "Request a corrected invoice if the printed amounts conflict."
            ),
        )
        subtotal = decimal(data.get("subtotal"))
        if data.get("subtotal") is not None:
            add(
                "subtotal",
                "Subtotal",
                "passed" if subtotal is not None and abs(subtotal - line_sum) <= CENT else "review",
                f"Line sum {usd(line_sum)} compared with the stated subtotal.",
            )
        if assumptions:
            add(
                "assumptions",
                "Optional amount assumptions",
                "passed" if header_difference <= CENT else "review",
                "Policy assumption: absent "
                + ", ".join(assumptions)
                + " treated as zero only when complete totals reconcile. These are not observed zeros.",
            )
    else:
        add(
            "arithmetic",
            "Invoice totals reconcile",
            "review",
            "Resolve missing or inconsistent amounts before reconciling invoice totals.",
        )

    if vendor and data.get("invoice_number"):
        reference = identity(data["invoice_number"])
        collisions = [
            p
            for p in prior
            if p["vendor_id"] == vendor["id"] and identity(p["reference"]) == reference
        ]
        if collisions:
            original = collisions[0]
            confirmed = (
                decimal(original.get("total")) == total
                and original.get("date") == raw_date
                and original.get("currency") == data.get("currency")
            )
            duplicate_id = original.get("invoice_id")
            add(
                "duplicate",
                "Duplicate check",
                "blocked" if confirmed else "review",
                "This business invoice already exists. No additional commitment was created."
                if confirmed
                else "The same vendor and invoice reference have conflicting dates or amounts. Resolve the conflicting document with AP.",
            )
        elif any(
            p["vendor_id"] == vendor["id"]
            and weak_identity(p["reference"]) == weak_identity(reference)
            for p in prior
        ):
            add(
                "duplicate",
                "Similar invoice reference",
                "review",
                "A similar invoice reference exists. Confirm the significant punctuation and leading zeros with AP.",
            )
        else:
            add(
                "duplicate",
                "Duplicate check",
                "passed",
                "No existing business invoice with this vendor and reference.",
            )
    else:
        add(
            "duplicate",
            "Duplicate check",
            "review",
            "Confirm vendor and invoice reference before checking duplicates.",
        )
    if po:
        accepted = [c for c in commitments if c["po_id"] == po["id"]]
        committed = sum((decimal(c["amount"]) for c in accepted), ZERO)
        remaining = decimal(po["ceiling"]) - committed
        shortfall = max(ZERO, (total or ZERO) - remaining)
        comparison.update(
            {
                "po_reference": po["reference"],
                "ceiling": money(decimal(po["ceiling"])),
                "committed_before": money(committed),
                "remaining_before": money(remaining),
                "shortfall": money(shortfall),
                "lines": price_rows,
            }
        )
        budget_ok = total is not None and total > 0 and total <= remaining
        add(
            "budget",
            "Remaining PO amount",
            "passed" if budget_ok else "review",
            f"{usd(remaining)} available before this invoice."
            if budget_ok
            else f"Only {usd(remaining)} remains on this PO. This invoice exceeds it by {usd(shortfall)}. Ask procurement to resolve the shortfall."
            if total is not None and total > 0
            else "A supported positive invoice total is required before checking the remaining PO amount.",
        )
        for line in po["lines"]:
            sku = line["sku"]
            previous = sum((decimal(c["quantities"].get(sku, "0")) for c in accepted), ZERO)
            incoming = allocations.get(sku, ZERO)
            available = decimal(line["quantity"]) - previous
            if incoming:
                add(
                    "quantity_" + sku,
                    f"{sku} cumulative quantity",
                    "passed" if incoming <= available else "review",
                    f"{incoming} {line['unit']} billed; {available} remaining of {line['quantity']} authorized.",
                )
    else:
        add(
            "budget",
            "PO amount and quantities",
            "review",
            "Select a supported purchase order to calculate remaining amount and quantities.",
        )

    outcome = (
        "BLOCKED"
        if any(c["state"] == "blocked" for c in checks)
        else "NEEDS_REVIEW"
        if any(c["state"] == "review" for c in checks)
        else "APPROVED"
    )
    issues = [c for c in checks if c["state"] in ("blocked", "review")]
    priority = {"duplicate": 0, "vendor": 1, "budget": 2, "arithmetic": 3, "po": 4}
    issues.sort(key=lambda c: (0 if c["state"] == "blocked" else 1, priority.get(c["code"], 9)))
    summary = (
        issues[0]["message"]
        if issues
        else "All checks passed. Accepted for the next accounts-payable step."
    )
    owner = "Accounts payable" if outcome != "APPROVED" else "AP payment preparation"
    next_action = (
        "Proceed to the next AP step. This is not a payment authorization or receipt confirmation."
    )
    if issues:
        next_action = summary
        if issues[0]["code"] == "budget":
            owner = "Procurement"
        elif issues[0]["code"] in ("arithmetic", "tax_amount"):
            owner = "Vendor / accounts payable"
    if po and total is not None:
        comparison["remaining_after"] = money(
            remaining - total if outcome == "APPROVED" else remaining
        )
    return {
        "outcome": outcome,
        "checks": checks,
        "summary": summary,
        "next_action": next_action,
        "owner": owner,
        "vendor_id": vendor["id"] if vendor else None,
        "po_id": po["id"] if po else None,
        "comparison": comparison,
        "duplicate_id": duplicate_id,
        "allocations": {k: str(v) for k, v in allocations.items()},
        "candidates": {"vendors": vendors, "orders": candidates},
    }
