"""Plain-language groups and reasons derived from recorded policy checks.

They are computed whenever a response or a progress event is built, so decisions
recorded before groups existed present the same way. Nothing here changes an
outcome: the rules engine alone decides.
"""

import re

from .rules import ISSUE_PRIORITY, decimal, usd

GROUPS = ("document", "supplier", "po", "lines", "totals", "duplicate", "budget")
TOTALS = frozenset(
    {
        "tax_treatment",
        "tax_amount",
        "net_amount",
        "tax_rate_amount",
        "zero_tax",
        "arithmetic",
        "subtotal",
        "assumptions",
    }
)
LINE_CHECK = re.compile(r"(?:line|line_match|price)_\d+")
STATE_RANK = {"skipped": 0, "passed": 1, "review": 2, "blocked": 3}

REASONS = {
    "nopo": "No PO on the invoice",
    "budget": "Over the PO budget",
    "price": "Price above tolerance",
    "totals": "Totals don’t add up",
    "duplicate": "Duplicate invoice",
    "closed": "PO already closed",
    "inactive": "Supplier inactive",
    "nonumber": "Missing invoice number",
    "item": "Item not on the PO",
    "vendor": "Unknown supplier",
    "evidence": "Value not found on the page",
    "po": "Purchase order issue",
    "other": "Needs clarification",
}
# Reasons that describe how a value was read rather than what is wrong with
# the invoice; a specific reason is preferred when both are present.
GENERIC = frozenset({"evidence", "other"})

FIELD_LABELS = {
    "vendor_name": "supplier name",
    "vendor_identifier": "supplier ID",
    "po_reference": "purchase order",
    "unit_price": "unit price",
}
SUMMARY_FIELDS = (
    "vendor_name",
    "vendor_identifier",
    "invoice_number",
    "invoice_date",
    "due_date",
    "po_reference",
    "currency",
    "subtotal",
    "header_discount",
    "shipping",
    "tax",
    "tax_rate",
    "total",
)


def check_group(code: str) -> str:
    if code == "vendor":
        return "supplier"
    if code in ("po", "duplicate", "budget"):
        return code
    if code == "lines" or LINE_CHECK.fullmatch(code):
        return "lines"
    if code in TOTALS:
        return "totals"
    if code.startswith("quantity_"):
        # Cumulative quantity is what is left on the order, next to its amount.
        return "budget"
    return "document"


def with_groups(checks):
    return [{**check, "group": check_group(check["code"])} for check in checks]


def classify(check, extraction) -> str:
    code, state, message = check["code"], check["state"], check["message"]
    printed_po = bool(extraction.get("po_reference"))
    if code == "vendor":
        return "inactive" if state == "blocked" else "vendor"
    if code == "po":
        if state == "blocked":
            return "closed"
        if printed_po or message.startswith("Purchase order vendor or currency"):
            return "po"
        return "nopo"
    if code == "duplicate":
        if not extraction.get("invoice_number"):
            return "nonumber"
        return "vendor" if message.startswith("Confirm vendor") else "duplicate"
    if code == "budget":
        if message.startswith("Select a supported purchase order"):
            return "po" if printed_po else "nopo"
        if message.startswith("A supported positive invoice total"):
            return "totals"
        return "budget"
    if code.startswith("quantity_"):
        return "budget"
    if code.startswith("price_"):
        return "price"
    if code.startswith("line_match_"):
        return "item"
    if LINE_CHECK.fullmatch(code) or code in TOTALS or code in ("precision", "required_total"):
        return "totals"
    if code == "required_invoice_number":
        return "nonumber"
    if code in ("required_vendor_name", "required_vendor_identifier"):
        return "vendor"
    if code == "evidence":
        return "evidence"
    return "other"


def reason_for(checks, extraction) -> str | None:
    """Why a decision is not approved, following the decision summary's own order."""
    issues = [c for c in checks or [] if c["state"] in ("blocked", "review")]
    if not issues:
        return None
    issues.sort(
        key=lambda c: (0 if c["state"] == "blocked" else 1, ISSUE_PRIORITY.get(c["code"], 9))
    )
    reasons = [classify(c, extraction or {}) for c in issues]
    return next((r for r in reasons if r not in GENERIC), reasons[0])


def group_state(checks) -> str:
    states = [c["state"] for c in checks if c["state"] != "skipped"]
    return max(states, key=STATE_RANK.__getitem__) if states else "skipped"


def field_label(path: str) -> str:
    parts = path.split(".")
    if len(parts) == 3 and parts[0] == "lines" and parts[1].isdigit():
        name = FIELD_LABELS.get(parts[2], parts[2].replace("_", " "))
        return f"line {int(parts[1]) + 1} {name}"
    return FIELD_LABELS.get(path, path.replace("_", " "))


def quantity_text(value) -> str:
    value = value.normalize()
    return f"{value:,.0f}" if value == value.to_integral_value() else f"{value:,f}"


def plural(unit: str, quantity) -> str:
    if quantity == 1:
        return unit
    return unit + ("es" if unit.endswith(("s", "x", "ch", "sh")) else "s")


def issue_message(check) -> str:
    if check["code"] == "evidence" and ": " in check["message"]:
        fields = check["message"].split(": ", 1)[1].split(", ")
        return "Not found on the page: " + ", ".join(field_label(f) for f in fields) + "."
    return check["message"]


def percent(value) -> str:
    return f"{value.normalize():f}%"


def tax_inclusive(data) -> bool:
    return data.get("tax_treatment") == "inclusive" and decimal(data.get("tax_rate")) is not None


def line_message(row, data) -> str | None:
    """The printed price, and the net price compared with the order when tax is included."""
    quantity, net, order = (
        decimal(row.get(k)) for k in ("invoice_quantity", "invoice_price", "po_price")
    )
    if quantity is None or net is None or order is None:
        return None
    printed = decimal(row.get("invoice_printed_price")) or net
    text = f"{row['sku']} · {quantity_text(quantity)} {plural(row['unit'], quantity)} at {usd(printed)}"
    if printed != net:
        rate = decimal(data.get("tax_rate"))
        tax = f"{percent(rate)} tax" if rate is not None else "tax"
        text += f" incl. {tax} → {usd(net)} net"
    if net == order:
        return text + ", the order price"
    if net < order:
        return text + f", below the {usd(order)} order price"
    return text + f" · {usd(net - order)} above the order price, within tolerance"


def read_message(pages) -> str:
    """How the pages were read: embedded text, or OCR of a scan."""
    count = len(pages or [])
    if any(page.get("method") == "ocr" for page in pages or []):
        return (
            f"Scanned {plural('page', count)} · text recognised with OCR · "
            f"{count} {plural('page', count)}"
        )
    return "Text layer found · no OCR needed"


def comparison_view(comparison, extraction):
    """Line prices both as printed and net of tax, for decisions recorded earlier too.

    ``invoice_price`` has always been the net unit price compared with the order.
    """
    rows = []
    lines = (extraction or {}).get("lines") or []
    for row in (comparison or {}).get("lines") or []:
        row = dict(row)
        row.setdefault("invoice_net_price", row.get("invoice_price", ""))
        if "invoice_printed_price" not in row:
            printed = next(
                (
                    decimal(line.get("unit_price"))
                    for line in lines
                    if (line.get("sku") or "").casefold() == (row.get("sku") or "").casefold()
                ),
                None,
            )
            row["invoice_printed_price"] = (
                f"{printed:.2f}" if printed is not None else row["invoice_net_price"]
            )
        rows.append(row)
    return {**(comparison or {}), "lines": rows}


def passed_message(group, checks, result, data, po_source) -> str:
    comparison = result.get("comparison") or {}
    vendor = next(
        (
            v
            for v in (result.get("candidates") or {}).get("vendors", [])
            if v["id"] == result.get("vendor_id")
        ),
        None,
    )
    total = decimal(data.get("total"))
    if group == "document":
        fields = sum(data.get(name) not in (None, "") for name in SUMMARY_FIELDS)
        lines = len(data.get("lines") or [])
        return f"{fields} fields · {lines} {plural('line', lines)} · each value linked to the page"
    if group == "supplier" and vendor:
        return f"{vendor['name']} · {vendor['identifier']}"
    if group == "po":
        suffix = {
            "printed": "printed on the invoice",
            "reviewer": "confirmed by a reviewer",
            "document": "matched from a company document",
        }.get(po_source)
        return f"{checks[0]['message']} · {suffix}" if suffix else checks[0]["message"]
    if group == "lines":
        rows = comparison.get("lines") or []
        if len(rows) == 1 and (message := line_message(rows[0], data)):
            return message
        if rows:
            matches = "line matches" if len(rows) == 1 else "lines match"
            return f"{len(rows)} {matches} {comparison.get('po_reference')}"
    if group == "totals" and comparison.get("normalized") and total is not None:
        normalized = comparison["normalized"]
        net, tax = decimal(normalized["net"]), decimal(normalized["tax"])
        if tax_inclusive(data):
            # Printed lines already include the tax; never present the net sum as the lines.
            return (
                f"Lines {usd(decimal(normalized['gross']))} incl. "
                f"{percent(decimal(data['tax_rate']))} tax = total {usd(total)} · "
                f"{usd(net)} net + {usd(tax)} tax"
            )
        adjusted = any((decimal(data.get(f)) or 0) != 0 for f in ("header_discount", "shipping"))
        return f"{'Net' if adjusted else 'Lines'} {usd(net)} + tax {usd(tax)} = total {usd(total)}"
    if group == "duplicate" and vendor and data.get("invoice_number"):
        return f"No earlier {data['invoice_number']} from {vendor['name']}"
    if group == "budget":
        remaining = decimal(comparison.get("remaining_before"))
        if remaining is not None and total is not None:
            return (
                f"{usd(remaining)} left on {comparison.get('po_reference')} · "
                f"{usd(remaining - total)} after this invoice"
            )
    return checks[0]["message"] if checks else "Checked."


WAITING_FOR_SUPPLIER = "Waiting for the supplier to be confirmed"
WAITING_FOR_ORDER = "Waiting for a purchase order"
NOTHING_RESERVED = "Nothing is reserved for a blocked invoice"


def waiting(group, result, data):
    """A dependent step that cannot be judged yet, instead of a misleading result.

    Orders, lines and budget depend on a confirmed supplier; lines and budget
    depend on a confirmed purchase order (a ✓ for lines would claim a match
    that never happened). A blocked invoice never reserves budget, so no
    balance "after this invoice" is shown. The decision itself is unchanged:
    the blocking check is reported in its own group.
    """
    if result.get("vendor_id") is None and group in ("po", "lines", "budget"):
        if group == "po" and data.get("po_reference"):
            return f"{data['po_reference']} printed · waiting for the supplier to be confirmed"
        return WAITING_FOR_SUPPLIER
    if group == "budget" and result.get("outcome") == "BLOCKED":
        return NOTHING_RESERVED
    if group in ("lines", "budget") and result.get("po_id") is None:
        return WAITING_FOR_ORDER
    return None


def group_events(result, data, *, po_source=None):
    """One (stage, state, message) per group: its worst state and most relevant message."""
    grouped = {group: [] for group in GROUPS}
    for check in result["checks"]:
        grouped[check_group(check["code"])].append(check)
    events = []
    for group in GROUPS:
        checks = grouped[group]
        if message := waiting(group, result, data):
            events.append((f"check:{group}", "skipped", message))
            continue
        state = group_state(checks)
        if state in ("blocked", "review"):
            message = issue_message(next(c for c in checks if c["state"] == state))
        elif state == "passed":
            message = passed_message(group, checks, result, data, po_source)
        else:
            message = "Not checked for this invoice."
        events.append((f"check:{group}", state, message))
    return events


def po_source(data, selections, auto_matched=False):
    if auto_matched:
        return "document"
    if selections.get("po_id"):
        return "reviewer"
    return "printed" if data.get("po_reference") else None
