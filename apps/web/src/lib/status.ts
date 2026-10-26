import type {
  Check,
  CheckGroup,
  InvoiceRow,
  InvoiceStatus,
  ReasonCode,
} from "./api";
import { firstWord } from "./format";

export const STATUS_LABEL: Record<InvoiceStatus, string> = {
  CHECKING: "Checking",
  FAILED: "Couldn’t read",
  APPROVED: "Approved",
  NEEDS_REVIEW: "Needs review",
  BLOCKED: "Blocked",
  ON_HOLD: "On hold",
  REJECTED: "Rejected",
};
export const STATUS_PILL: Record<InvoiceStatus, string> = {
  CHECKING: "is-processing",
  FAILED: "is-blocked",
  APPROVED: "is-approved",
  NEEDS_REVIEW: "is-review",
  BLOCKED: "is-blocked",
  ON_HOLD: "is-hold",
  REJECTED: "",
};
/** Mark colours (dots, meters). Text never uses these. */
export const STATUS_DOT: Record<InvoiceStatus, string> = {
  CHECKING: "var(--accent)",
  FAILED: "var(--bad-dot)",
  APPROVED: "var(--ok-dot)",
  NEEDS_REVIEW: "var(--warn-dot)",
  BLOCKED: "var(--bad-dot)",
  ON_HOLD: "var(--hold-dot)",
  REJECTED: "var(--grey-dot)",
};
export const STATUS_TEXT: Record<InvoiceStatus, string> = {
  CHECKING: "var(--accent-ink)",
  FAILED: "var(--bad)",
  APPROVED: "var(--ok)",
  NEEDS_REVIEW: "var(--warn)",
  BLOCKED: "var(--bad)",
  ON_HOLD: "var(--hold)",
  REJECTED: "var(--muted)",
};

export const REASON_LABEL: Record<ReasonCode, string> = {
  nopo: "No PO on the invoice",
  budget: "Over the PO budget",
  price: "Price above tolerance",
  totals: "Totals don’t add up",
  duplicate: "Duplicate invoice",
  closed: "PO already closed",
  inactive: "Supplier inactive",
  nonumber: "Missing invoice number",
  item: "Item not on the PO",
  vendor: "Unknown supplier",
  evidence: "Value not found on the page",
  po: "Purchase order issue",
  other: "Needs clarification",
};
export function reasonText(
  code: ReasonCode | null | undefined,
  label?: string | null,
) {
  return (code && REASON_LABEL[code]) || label || null;
}

/** The approved supplier record's name when matched, else the printed name. */
export function supplierLabel(row: InvoiceRow, names: Map<string, string>) {
  return (row.vendor_id ? names.get(row.vendor_id) : undefined) ?? row.vendor;
}

export function isDecided(status: InvoiceStatus) {
  return status !== "CHECKING" && status !== "FAILED";
}
/** Waiting on someone in AP (or on a reply AP asked for). */
export function isOpen(status: InvoiceStatus) {
  return status === "NEEDS_REVIEW" || status === "ON_HOLD";
}

/** Who acts next and what they do, for a reason code. */
export function reasonNext(
  code: ReasonCode | null | undefined,
  context: { po?: string | null; vendor?: string | null },
) {
  const po = context.po || "the order";
  const supplier = firstWord(context.vendor) || "the supplier";
  switch (code) {
    case "budget":
      return `Procurement · amend ${po} or ask ${supplier} to re-bill`;
    case "nopo":
      return "AP reviewer · confirm the order";
    case "totals":
      return "Supplier · send a corrected invoice";
    case "price":
      return "Supplier · re-bill at the order price";
    case "nonumber":
      return "Supplier · send a numbered invoice";
    case "duplicate":
      return "No action · kept for the audit trail";
    case "closed":
      return "Supplier · re-bill against an open order";
    case "inactive":
      return "Procurement · reactivate the supplier, or reject";
    case "item":
      return "AP reviewer · confirm the item";
    case "vendor":
      return "AP reviewer · confirm the supplier";
    case "evidence":
      return "AP reviewer · check the value on the page";
    case "po":
      return "AP reviewer · confirm the purchase order";
    default:
      return "AP reviewer";
  }
}

export function nextStep(row: InvoiceRow) {
  switch (row.status) {
    case "CHECKING":
      return "Checks are running";
    case "FAILED":
      return "Read it again, or ask for a clearer copy";
    case "APPROVED":
      return "Payment prep · AP team";
    case "REJECTED":
      return "Closed · nothing reserved";
    case "ON_HOLD":
      return row.workflow_to
        ? `Waiting on ${row.workflow_to}`
        : "Waiting on a reply";
    default:
      return reasonNext(row.reason_code, {
        po: row.po_reference,
        vendor: row.vendor,
      });
  }
}

const GROUP_BY_CODE: Record<string, CheckGroup> = {
  vendor: "supplier",
  po: "po",
  lines: "lines",
  tax_treatment: "totals",
  tax_amount: "totals",
  net_amount: "totals",
  tax_rate_amount: "totals",
  zero_tax: "totals",
  arithmetic: "totals",
  subtotal: "totals",
  assumptions: "totals",
  duplicate: "duplicate",
  budget: "budget",
};
/** The server sends `group`; this mapping only covers responses without it. */
export function groupOf(check: Check): CheckGroup {
  if (check.group) return check.group;
  if (GROUP_BY_CODE[check.code]) return GROUP_BY_CODE[check.code];
  if (/^(line_|line_match_|price_)/.test(check.code)) return "lines";
  if (check.code.startsWith("quantity_")) return "budget";
  return "document";
}

export type CheckState = "passed" | "review" | "blocked" | "skipped";
const SEVERITY: Record<string, number> = {
  blocked: 3,
  failed: 3,
  review: 2,
  passed: 1,
  skipped: 0,
};
/** Worst state: blocked › review › passed; skipped only if all are skipped. */
export function worstState(states: string[]): CheckState | null {
  if (!states.length) return null;
  const top = Math.max(...states.map((s) => SEVERITY[s] ?? 1));
  return top === 3
    ? "blocked"
    : top === 2
      ? "review"
      : top === 1
        ? "passed"
        : "skipped";
}
