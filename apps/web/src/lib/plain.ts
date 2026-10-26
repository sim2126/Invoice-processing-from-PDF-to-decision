import type { Check } from "./api";
import { qty, units } from "./format";

/*
 * The rules engine writes precise messages for auditors. These helpers turn
 * the common ones into short AP language; anything unrecognised is shown as
 * the engine wrote it, so nothing is ever hidden or invented.
 */
const FIELD_LABEL: Record<string, string> = {
  vendor_name: "supplier name",
  vendor_identifier: "supplier ID",
  invoice_number: "invoice number",
  invoice_date: "invoice date",
  due_date: "due date",
  po_reference: "purchase order",
  currency: "currency",
  subtotal: "subtotal",
  header_discount: "discount",
  shipping: "shipping",
  tax: "tax",
  tax_rate: "tax rate",
  total: "total",
  sku: "item",
  description: "description",
  quantity: "quantity",
  unit: "unit",
  unit_price: "unit price",
  discount: "discount",
};

export function fieldName(path: string) {
  const line = /^lines\.(\d+)\.(\w+)$/.exec(path);
  if (line)
    return `line ${Number(line[1]) + 1} ${FIELD_LABEL[line[2]] ?? line[2].replaceAll("_", " ")}`;
  return FIELD_LABEL[path] ?? path.replaceAll("_", " ");
}

const MONEY = "(\\$[\\d,]+(?:\\.\\d+)?)";
const NUMBER = "([\\d,]+(?:\\.\\d+)?)";
const amountOf = (text: string) => Number(text.replace(/[$,]/g, ""));
const usd = (value: number) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the wording may depend on beyond the message itself. */
export type PlainContext = {
  /** PO reference printed on the invoice, if any. */
  printedPo?: string | null;
  /** State of the check the message belongs to. */
  state?: string;
  /** Quantity unit of the line, for "per case" wording. */
  unit?: string | null;
};

export function plainText(
  message: string,
  code?: string,
  context: PlainContext = {},
): string {
  let m: RegExpExecArray | null;
  if ((m = /^Read (\d+) page\(s\)\. Source coordinates retained/.exec(message)))
    return `${m[1]} ${m[1] === "1" ? "page" : "pages"} read`;
  if (code === "required_invoice_number" && /missing/i.test(message))
    return "No invoice number printed, so duplicates can’t be ruled out";
  if (code?.startsWith("required_") && /missing/i.test(message))
    return `No ${fieldName(code.slice("required_".length))} found on the invoice`;
  if ((m = /^Verify source evidence for: (.+?)\.?$/.exec(message)))
    return `Not found on the page: ${m[1].split(/,\s*/).map(fieldName).join(", ")}`;
  if (
    (m = new RegExp(`^Calculated ${MONEY} / stated ${MONEY}`).exec(message))
  ) {
    return amountOf(m[1]) === amountOf(m[2]) || /Within the/.test(message)
      ? `Lines and tax add up to the printed total of ${m[2]}`
      : `Lines add to ${m[1]}, but the printed total is ${m[2]}`;
  }
  if (
    (m = new RegExp(
      `^Only ${MONEY} remains on this PO\\. This invoice exceeds it by ${MONEY}`,
    ).exec(message))
  )
    return `Only ${m[1]} left on the order · short by ${m[2]}`;
  if ((m = new RegExp(`^${MONEY} available before this invoice`).exec(message)))
    return `${m[1]} left on the order before this invoice`;
  if ((m = new RegExp(`^Invoice ${MONEY} / PO ${MONEY}`).exec(message))) {
    const diff = amountOf(m[1]) - amountOf(m[2]);
    if (diff === 0) return `${m[1]}, the order price`;
    if (diff < 0) return `${m[1]}, below the ${m[2]} order price`;
    const pct = ((diff / amountOf(m[2])) * 100).toFixed(1);
    const per = context.unit ? ` per ${context.unit}` : "";
    const limits =
      context.state === "passed"
        ? ", inside the 1% and $1.00 per-unit limits"
        : context.state === "review" || context.state === "blocked"
          ? ", over the 1% and $1.00 per-unit limits"
          : "";
    return `${m[1]} vs ${m[2]} on the order · ${usd(diff)}${per} (+${pct}%) above${limits}`;
  }
  if (
    (m = new RegExp(
      `^${NUMBER} (\\S+) billed; ${NUMBER} remaining of ${NUMBER} authori[sz]ed`,
    ).exec(message))
  )
    return `${units(m[1].replace(/,/g, ""), m[2])} billed · ${qty(m[3].replace(/,/g, ""))} left of ${qty(m[4].replace(/,/g, ""))} on the order`;
  if (
    (m = new RegExp(
      `^Quantity × price − line discount compared with stated total; difference ${MONEY}`,
    ).exec(message))
  )
    return amountOf(m[1]) === 0
      ? "Quantity × price matches the line total"
      : `Quantity × price differs from the line total by ${m[1]}`;
  if (/^Line amounts are net; stated tax is added once/.test(message))
    return "Line amounts are net; tax is added once";
  if (/^This business invoice already exists/.test(message))
    return "Same supplier, invoice number, date and total as an earlier invoice";
  if (/^No existing business invoice/.test(message))
    return "No earlier invoice with this number from this supplier";
  if (/^Confirm the vendor against the approved register/.test(message))
    return "The supplier couldn’t be matched to an approved supplier";
  if ((m = /^(.+) is inactive in the approved register/.exec(message)))
    return `${m[1]} is inactive in the supplier list`;
  if ((m = /^(.+) is active in the approved register/.exec(message)))
    return `${m[1]} is an approved supplier`;
  if ((m = /^(\d+) supported purchase orders?\./.exec(message))) {
    const fit = `${m[1]} open ${m[1] === "1" ? "order fits" : "orders fit"}`;
    return context.printedPo
      ? `${context.printedPo} isn’t an open order for this supplier · ${fit}`
      : `No PO printed · ${fit}`;
  }
  if (/^No supported purchase order/.test(message))
    return context.printedPo
      ? `${context.printedPo} isn’t an open order for this supplier`
      : "No PO printed, and no open order fits";
  if ((m = /^(\S+) is closed or cancelled/.exec(message)))
    return `${m[1]} is closed · nothing more can be billed to it`;
  if (/^Confirm an exact SKU\/approved line description/.test(message))
    return "An item isn’t on the order in the same unit";
  return message.replace(/\.\s*$/, "");
}

export function plainCheck(check: Check, context: PlainContext = {}) {
  return plainText(check.message, check.code, { ...context, state: check.state });
}

/** Why a run stopped, without retry counters or revision jargon. */
export function plainRunError(message: string | null | undefined) {
  if (!message) return "The document couldn’t be read, so nothing was decided.";
  if (/attempts?/i.test(message) && /stopped|failed/i.test(message))
    return "Reading stopped after several tries. Try again once the service is back.";
  if (/newer revision/i.test(message))
    return "A newer version of this invoice replaced this check.";
  return message;
}

/** "45 case billed; 40 remaining of 100 authorized." → structured numbers. */
export function parseQuantity(message: string) {
  const m = new RegExp(
    `^${NUMBER} (\\S+) billed; ${NUMBER} remaining of ${NUMBER} authori[sz]ed`,
  ).exec(message);
  if (!m) return null;
  const clean = (v: string) => v.replace(/,/g, "");
  return {
    billed: clean(m[1]),
    unit: m[2],
    left: clean(m[3]),
    authorized: clean(m[4]),
  };
}

/** A phrase as a sentence: capitalised, ending with a full stop. */
export function sentence(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capital = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?…]["”’)]?$/.test(capital) ? capital : `${capital}.`;
}
