import type {
  AiNoMatchAfter,
  Assistance,
  Audit,
  Check,
  Detail,
  Evidence,
  InvoiceRow,
  PurchaseOrder,
} from "./api";
import {
  dayLabel,
  firstWord,
  moment,
  money,
  qty,
  receivedLabel,
  units,
} from "./format";
import {
  lineFacts,
  linePercent,
  linesSentence,
  priceText,
  toleranceSummary,
  worstPrice,
} from "./lines";
import { parseQuantity, plainCheck, sentence, type PlainContext } from "./plain";
import { groupOf, reasonNext, STATUS_LABEL } from "./status";
import { supplierName } from "./steps";

export type CiteKey =
  | "vendorId"
  | "number"
  | "date"
  | "po"
  | "line"
  | "qty"
  | "price"
  | "total"
  | "tax";

export const CITES: Record<CiteKey, { label: string; fields: string[] }> = {
  vendorId: { label: "Supplier ID", fields: ["vendor_identifier", "vendor_name"] },
  number: { label: "Invoice no.", fields: ["invoice_number"] },
  date: { label: "Date", fields: ["invoice_date"] },
  po: { label: "PO", fields: ["po_reference"] },
  line: { label: "Line 1", fields: ["lines.0.sku", "lines.0.description"] },
  qty: { label: "Qty", fields: ["lines.0.quantity"] },
  price: { label: "Price", fields: ["lines.0.unit_price"] },
  total: { label: "Total", fields: ["total"] },
  tax: { label: "Tax", fields: ["tax"] },
};

/** The page evidence a citation chip points at, if the value was found. */
export function citeEvidence(evidence: Evidence[], key: CiteKey) {
  for (const field of CITES[key].fields) {
    const hit = evidence.find((e) => e.field === field && e.page);
    if (hit) return hit;
  }
  return null;
}

export type ActionKind =
  | "view-po"
  | "ask-procurement"
  | "choose-order"
  | "confirm-supplier"
  | "request-correction"
  | "reply-received"
  | "open-original"
  | "reject";
export type Why = {
  text: string;
  cites: CiteKey[];
  link?: { href: string; label: string };
};
export type Verdict = {
  title: string;
  summary: string;
  why: Why[];
  next: string;
  actions: ActionKind[];
};

function citesFor(check: Check): CiteKey[] {
  const code = check.code;
  if (code === "vendor") return ["vendorId"];
  if (code === "po") return ["po"];
  if (/^price_/.test(code)) return ["price"];
  if (/^(line_|line_match_|quantity_)/.test(code) || code === "lines") return ["line"];
  if (code === "duplicate") return ["number", "total"];
  if (code === "required_invoice_number") return ["number"];
  if (code === "date") return ["date"];
  if (groupOf(check) === "totals" || code === "budget") return ["total"];
  return [];
}

function joinAnd(items: string[]) {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Short notes are quoted; whole drafted emails stay in the History tab. */
function holdLine(note: string, by: string | null, to: string | null) {
  const text = note.replace(/\s+/g, " ").trim();
  return text.length <= 160 && !/\n\s*\n/.test(note)
    ? `${by ?? "AP"}: “${text}”`
    : `${by ?? "AP"} sent the request to ${to ?? "the supplier"}; the full message is in History`;
}

/** AI review results recorded for the invoice's current version. */
export function aiReview(detail: Detail) {
  const current = detail.audit.filter((a) => a.revision === detail.invoice.revision);
  return {
    match: current.find((a) => a.action === "AI_MATCH") ?? null,
    miss: current.find((a) => a.action === "AI_NO_MATCH") ?? null,
  };
}

/** "AI checked 2 company documents; none assigns this invoice to an order." */
export function noMatchText(audit: Audit) {
  const checked = Number((audit.after as Partial<AiNoMatchAfter>).documents_checked);
  if (!Number.isFinite(checked)) return audit.reason;
  return checked === 0
    ? "AI found no company documents on file to check"
    : `AI checked ${checked} company ${checked === 1 ? "document" : "documents"}; none assigns this invoice to an order`;
}

/** What reviewers confirmed or corrected, from the REVIEW audit entries. */
function reviewed(detail: Detail): { text: string; cites: CiteKey[] } {
  let supplier = false;
  let order = false;
  const fields = new Set<string>();
  for (const audit of detail.audit) {
    if (audit.action !== "REVIEW") continue;
    const after = audit.after as Record<string, unknown>;
    if (after.vendor_selection) supplier = true;
    if (after.purchase_order) order = true;
    for (const key of Object.keys(after))
      if (key !== "vendor_selection" && key !== "purchase_order") fields.add(key);
  }
  if (supplier && order)
    return {
      text: "The supplier and the order were confirmed by a reviewer, and every check ran again",
      cites: ["vendorId", "po"],
    };
  if (supplier)
    return {
      text: "The supplier was confirmed by a reviewer, and every check ran again",
      cites: ["vendorId"],
    };
  if (order)
    return {
      text: "The order was confirmed by a reviewer, and every check ran again",
      cites: ["po"],
    };
  if (fields.size)
    return { text: "A reviewer corrected the invoice, and every check ran again", cites: [] };
  return { text: "Every check ran again after a review", cites: [] };
}

type Context = { invoices: InvoiceRow[]; orders: PurchaseOrder[]; now: number };

function facts(detail: Detail, orders: PurchaseOrder[]) {
  const inv = detail.invoice;
  const decision =
    detail.decision && inv.decision_applicable ? detail.decision : null;
  const x = detail.extraction;
  const cmp = decision?.comparison ?? {};
  const line = x?.lines[0];
  const vendor = supplierName(detail) ?? "The supplier";
  const po = cmp.po_reference || inv.po_reference || x?.po_reference || null;
  const order = po ? orders.find((o) => o.reference === po) : undefined;
  const poPrice = cmp.lines?.[0]?.po_price ?? order?.lines[0]?.unit_price ?? null;
  const quantity = decision?.checks.find(
    (c) => c.code.startsWith("quantity_") && c.state !== "passed",
  );
  const lines = lineFacts(detail);
  const context: PlainContext = {
    printedPo: x?.po_reference ?? null,
    unit: lines?.unit ?? line?.unit ?? null,
  };
  return {
    inv,
    decision,
    x,
    cmp,
    line,
    vendor,
    supplier: firstWord(vendor) || "the supplier",
    po,
    order,
    poPrice,
    lines,
    context,
    total: money(inv.total ?? x?.total),
    sku: line?.sku || line?.description || "The item",
    billed: line ? units(line.quantity, line.unit) : null,
    price: money(line?.unit_price),
    over: quantity ? parseQuantity(quantity.message) : null,
    assistant: (decision?.assistant ?? {}) as Assistance,
  };
}

export function buildVerdict(detail: Detail, ctx: Context): Verdict | null {
  const f = facts(detail, ctx.orders);
  const d = f.decision;
  if (!d) return null;
  const { inv, cmp, po, lines } = f;
  const code = inv.reason_code ?? d.reason_code ?? null;
  const issues = [
    ...d.checks.filter((c) => c.state === "blocked"),
    ...d.checks.filter((c) => c.state === "review"),
  ];
  const plain = (check: Check) => plainCheck(check, f.context);
  const groupPassed = (group: string) =>
    d.checks.filter((c) => groupOf(c) === group).every((c) => c.state === "passed");
  const why: Why[] = [];
  const add = (text: string, cites: CiteKey[] = [], link?: Why["link"]) =>
    why.push({ text: sentence(text), cites, link });
  const firstIssue = issues[0] ? sentence(plain(issues[0])) : d.summary;
  const taxNote = lines?.inclusive ? " including tax" : "";
  let summary = firstIssue;
  let next = reasonNext(code, { po, vendor: f.vendor });
  let actions: ActionKind[] = [];
  const candidates = detail.candidates.orders;

  if (d.outcome === "APPROVED") {
    const doc = f.assistant.auto_matched
      ? f.assistant.sources?.find((s) => s.kind === "document")
      : undefined;
    if (f.assistant.auto_matched)
      add(
        `${po} was assigned to this invoice in ${doc?.title ?? "a company document"}, and every check ran again`,
        ["po"],
        doc?.document_id
          ? { href: `/api/documents/${doc.document_id}/source`, label: `Open ${doc.title}` }
          : undefined,
      );
    else if (inv.human_touched && detail.audit.some((a) => a.action === "REVIEW")) {
      const note = reviewed(detail);
      add(note.text, note.cites);
    } else add(`${f.vendor} is an approved supplier and ${po} is open`, ["vendorId", "po"]);
    const lineText = lines ? linesSentence(lines) : null;
    if (lineText) add(lineText, lines && lines.count > 1 ? ["line"] : ["line", "price"]);
    if (cmp.remaining_before)
      add(
        `The total of ${f.total}${taxNote} fits the ${money(cmp.remaining_before)} left on the order`,
        ["total"],
      );
    const reserved = `${f.total} is reserved on ${po}${cmp.remaining_after ? `, leaving ${money(cmp.remaining_after)}` : ""}.`;
    summary =
      (lines && toleranceSummary(lines)) ??
      `${f.assistant.auto_matched ? "Approved after a company document confirmed the order. " : inv.human_touched ? "Approved after review. " : "Every check passed. "}${reserved}`;
    next = "Payment prep · AP team";
    actions = ["view-po"];
  } else if (code === "budget") {
    add(
      `The order is right: ${po} covers ${f.sku}${f.poPrice ? ` at ${money(f.poPrice)}${lines?.inclusive ? " net" : ""}` : ""}`,
      ["po", "line"],
    );
    if (cmp.remaining_before)
      add(
        `Only ${money(cmp.remaining_before)} is left on it after earlier invoices, and this one is ${f.total}${taxNote}`,
        ["total"],
      );
    if (f.over)
      add(`It bills ${units(f.over.billed, f.over.unit)}; the order has ${qty(f.over.left)} left`, [
        "line",
      ]);
    summary =
      Number(cmp.shortfall) > 0
        ? `Over the budget left on ${po} by ${money(cmp.shortfall)}.`
        : f.over
          ? `Bills more than the ${qty(f.over.left)} left on ${po}.`
          : firstIssue;
    actions = ["ask-procurement", "reject"];
  } else if (code === "nopo") {
    const { miss } = aiReview(detail);
    if (miss) add(noMatchText(miss));
    if (groupPassed("supplier") && groupPassed("totals"))
      add("The supplier is approved and the totals add up", ["vendorId", "total"]);
    add("No purchase order number is printed on the invoice", ["po"]);
    const refs = candidates.map((o) => o.reference);
    if (refs.length > 1)
      add(
        `${joinAnd(refs)} are ${refs.length === 2 ? "both" : "all"} open for ${f.vendor}, so a wrong pick would misstate project spend`,
      );
    else if (refs.length === 1)
      add(`${refs[0]} is the only open order from ${f.vendor}, and it still needs confirming`);
    else add(`${f.vendor} has no open purchase order that could cover it`);
    summary =
      refs.length > 1
        ? `No purchase order on the invoice, and ${refs.length} open orders fit. Tickmark won’t guess.`
        : refs.length === 1
          ? "No purchase order on the invoice. One open order could cover it once someone confirms it."
          : "No purchase order on the invoice, and no open order fits.";
    actions = refs.length ? ["choose-order", "reject"] : ["reject"];
  } else if (code === "totals" && cmp.normalized?.gross) {
    const tax = f.x?.tax ?? cmp.normalized.tax ?? "0";
    add(
      `The line items${Number(tax) && !lines?.inclusive ? " and tax" : ""} add to ${money(cmp.normalized.gross)}`,
      ["line"],
    );
    add(
      `The printed total is ${f.total}, with ${money(tax)} tax${lines?.inclusive ? " included" : ""}`,
      ["total"],
    );
    add("Tickmark never edits a supplier’s figures to make them fit");
    summary = `The invoice contradicts itself: its lines add to ${money(cmp.normalized.gross)} but it prints ${f.total}.`;
    actions = ["request-correction", "reject"];
  } else if (code === "price" && lines && worstPrice(lines)) {
    const r = worstPrice(lines)!;
    const quantities = d.checks.filter((c) => c.code.startsWith("quantity_"));
    add(
      quantities.length && quantities.every((c) => c.state === "passed")
        ? `${r.sku} and the quantity match ${po}`
        : `${r.sku} is on ${po}`,
      ["line"],
    );
    add(
      `${priceText(lines, r)} vs ${money(r.po)} on the order: ${money(r.net - r.po)}${r.unit ? ` per ${r.unit}` : ""} (+${linePercent(r)}%) above, over the 1% and $1.00 per-unit limits`,
      ["price"],
    );
    summary = `Billed ${money(r.net - r.po)} per ${r.unit || "unit"} above the order price${lines.inclusive ? " (net of tax)" : ""}, more than the tolerance allows.`;
    actions = ["request-correction", "reject"];
  } else if (code === "nonumber") {
    add("Every other field was found and cited on the page", ["vendorId", "total"]);
    add("Without an invoice number, the duplicate check can’t run", ["number"]);
    summary = "No invoice number, so a duplicate can’t be ruled out.";
    actions = ["request-correction", "reject"];
  } else if (code === "duplicate") {
    const original = d.duplicate_id
      ? ctx.invoices.find((r) => r.id === d.duplicate_id)
      : undefined;
    add(
      `Same supplier, invoice number, date and total as ${original?.filename ?? "an earlier invoice"}`,
      ["number", "total"],
    );
    add("It arrived as a different PDF, so a file check alone would have missed it");
    summary = original
      ? `Already ${original.status === "APPROVED" ? "approved" : "received"} as ${original.reference ?? original.filename} (${receivedLabel(original.created_at, ctx.now)}). Nothing new was reserved.`
      : "This invoice was already received. Nothing new was reserved.";
    actions =
      d.outcome === "BLOCKED"
        ? d.duplicate_id
          ? ["open-original"]
          : []
        : [...(d.duplicate_id ? (["open-original"] as const) : []), "reject"];
  } else if (code === "closed") {
    add(
      `${po}${f.order ? ` (${f.order.description})` : ""} is closed, so nothing more can be billed to it`,
      ["po"],
    );
    add("Nothing was reserved against any order");
    summary = `${po} is closed. Nothing more can be billed to it.`;
    actions = ["reject"];
  } else if (code === "inactive") {
    add("The supplier ID on the invoice belongs to an inactive supplier", ["vendorId"]);
    add("Invoices from inactive suppliers stay blocked until procurement reactivates them");
    summary = `${f.vendor} is inactive in the supplier list.`;
    actions = ["reject"];
  } else if (code === "item") {
    add(`An item on the invoice isn’t on ${po ?? "the order"} in the same unit`, ["line"]);
    summary = `An item on the invoice is not on ${po ?? "the order"}.`;
    actions = ["request-correction", "reject"];
  } else if (code === "vendor") {
    const printed = f.x?.vendor_name ?? inv.vendor ?? "The supplier";
    add(`${printed} on the invoice couldn’t be matched to an approved supplier`, ["vendorId"]);
    add(
      f.x?.po_reference
        ? `${f.x.po_reference} is printed; the order is checked once the supplier is confirmed`
        : "The order, lines and budget are checked once the supplier is confirmed",
      f.x?.po_reference ? ["po"] : [],
    );
    summary = `${printed} couldn’t be matched to an approved supplier. Nothing is reserved until someone confirms who sent it.`;
    next = "AP reviewer · confirm the supplier";
    actions = ["confirm-supplier", "reject"];
  } else {
    for (const check of issues.slice(0, 3)) add(plain(check), citesFor(check));
    if (code === "evidence")
      add("A value with no source on the page can never support an approval");
    actions =
      d.outcome === "BLOCKED"
        ? ["reject"]
        : code === "po" && candidates.length
          ? ["choose-order", "reject"]
          : ["request-correction", "reject"];
  }

  if (inv.status === "ON_HOLD") {
    const since = inv.workflow_at ? moment(inv.workflow_at, ctx.now) : null;
    summary = `Waiting on ${inv.workflow_to ?? "a reply"}${since ? ` since ${since}` : ""}. ${summary}`;
    if (inv.workflow_note)
      why.unshift({
        text: sentence(holdLine(inv.workflow_note, inv.workflow_by, inv.workflow_to)),
        cites: [],
      });
    next = `${inv.workflow_to ?? "Supplier"} · reply to the request, then check again`;
    actions = ["reply-received", "reject"];
  }
  if (inv.status === "REJECTED") {
    const note = (inv.workflow_note || "no reason recorded").replace(/\.\s*$/, "");
    summary = `Rejected${inv.workflow_by ? ` by ${inv.workflow_by}` : ""}: ${note.charAt(0).toLowerCase()}${note.slice(1)}.`;
    next = "Closed · nothing reserved";
    actions = [];
  }

  const shown = why.slice(0, 3);
  // Scans: values read but not found on the page never support an approval.
  const unverified = detail.evidence.filter((e) => e.status === "unverified").length;
  if (unverified)
    shown.push({
      text: sentence(
        `${unverified} ${unverified === 1 ? "field" : "fields"} couldn’t be matched to the page text (see Fields)`,
      ),
      cites: [],
    });
  return { title: STATUS_LABEL[inv.status], summary, why: shown, next, actions };
}

export type Draft = { to: string; about: string; body: string };

/** "Ask procurement" / "Request a correction" message, AI draft first. */
export function buildDraft(
  detail: Detail,
  kind: "procurement" | "supplier",
  ctx: { orders: PurchaseOrder[]; user: string; company: string },
): Draft {
  const f = facts(detail, ctx.orders);
  const number = f.inv.reference ?? f.x?.invoice_number ?? null;
  const to = kind === "procurement" ? "Procurement" : f.vendor;
  const about = [number ?? "Invoice without a number", f.po].filter(Boolean).join(" · ");
  const draft = f.assistant.status === "ready" ? f.assistant.draft_message : null;
  if (draft?.trim()) return { to, about, body: draft.trim() };

  const signOff = `${ctx.user}\nAccounts Payable, ${ctx.company}`;
  if (kind === "procurement") {
    const left = f.cmp.remaining_before ? money(f.cmp.remaining_before) : null;
    const paragraphs = [
      "Hi,",
      `${f.vendor} invoice ${number ?? "(no number)"} is for ${f.total}${f.lines?.inclusive ? " including tax" : ""}${f.billed ? ` (${f.billed} at ${f.price})` : ""} against ${f.po ?? "our order"}.`,
      left
        ? `${f.po} has ${left} left after earlier invoices, so this invoice is ${money(f.cmp.shortfall)} over${f.over ? `, and it bills ${units(f.over.billed, f.over.unit)} where ${qty(f.over.left)} are left` : ""}.`
        : null,
      `Could you amend ${f.po ?? "the order"}, or confirm we should ask ${f.supplier} to re-bill within the order?`,
      `Thanks,\n${firstWord(ctx.user) || ctx.user}`,
    ];
    return { to, about, body: paragraphs.filter(Boolean).join("\n\n") };
  }

  const code = f.inv.reason_code ?? f.decision?.reason_code ?? null;
  const worst = f.lines ? worstPrice(f.lines) : null;
  let ask: string;
  if (code === "totals" && f.cmp.normalized?.gross) {
    const gap = Number(f.inv.total ?? f.x?.total) - Number(f.cmp.normalized.gross);
    ask = `Invoice ${number} lists ${f.billed ?? "its lines"}${f.billed ? ` at ${f.price}` : ""}, which adds to ${money(f.cmp.normalized.gross)}, but the printed total is ${f.total} with ${money(f.x?.tax ?? "0")} tax.\n\nPlease send a corrected invoice, or a breakdown of the ${money(Math.abs(gap))} difference.`;
  } else if (code === "price" && worst && f.lines) {
    ask = `Invoice ${number} bills ${priceText(f.lines, worst)} per ${worst.unit || "unit"}. Our order ${f.po} agrees ${money(worst.po)}${f.lines.inclusive ? " net of tax" : ""}.\n\nPlease re-bill at the order price, or send the approved rate change.`;
  } else if (code === "nonumber") {
    ask = `The invoice you sent on ${dayLabel(f.x?.invoice_date ?? f.inv.created_at)} for ${f.total} has no invoice number, so we can’t book it.\n\nPlease send a corrected copy with an invoice number.`;
  } else {
    const issue =
      f.decision?.checks.find((c) => c.state === "blocked") ??
      f.decision?.checks.find((c) => c.state === "review");
    const reason = issue
      ? plainCheck(issue, f.context)
      : (f.decision?.reason ?? "a detail needs correcting");
    ask = `We couldn’t book invoice ${number ?? "you sent"} for ${f.total}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.\n\nPlease send a corrected invoice.`;
  }
  return { to, about, body: `Hello,\n\n${ask}\n\nThank you,\n${signOff}` };
}
