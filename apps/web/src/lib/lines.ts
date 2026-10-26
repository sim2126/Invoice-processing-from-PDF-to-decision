import type { Detail } from "./api";
import { money, qty, units } from "./format";

/*
 * One reading of an invoice's lines against its order, shared by the step
 * list and the verdict so both always say the same thing. Prices are
 * compared net of tax (the policy rule); the printed price is kept for
 * tax-inclusive invoices so the copy never calls a gross price "the order
 * price".
 */
export type LineRow = {
  sku: string;
  unit: string | null;
  quantity: number;
  /** Printed unit price (includes tax on tax-inclusive invoices). */
  gross: number;
  /** Unit price net of tax, the value compared with the order. */
  net: number;
  /** Unit price on the purchase order. */
  po: number;
};

export type LineFacts = {
  count: number;
  rows: LineRow[];
  totalQuantity: number;
  /** The unit shared by every line, if they all use the same one. */
  unit: string | null;
  inclusive: boolean;
  /** Stated tax rate as a percentage without trailing zeros ("10"). */
  rate: string | null;
  tax: string | null;
  /** Every extracted line has a comparison with the order. */
  matched: boolean;
  above: LineRow[];
  below: LineRow[];
};

const num = (value: unknown) => {
  const n = Number(value);
  return value == null || value === "" || !Number.isFinite(n) ? null : n;
};

export function lineFacts(detail: Detail): LineFacts | null {
  const x = detail.extraction;
  if (!x || !x.lines.length) return null;
  const decision =
    detail.decision && detail.invoice.decision_applicable ? detail.decision : null;
  const cmp = decision?.comparison;
  const inclusive = x.tax_treatment === "inclusive";
  const rateNumber = num(x.tax_rate);
  const rows: LineRow[] = [];
  (cmp?.lines ?? []).forEach((line, index) => {
    const extracted =
      x.lines.find((l) => (l.sku ?? "").toLowerCase() === (line.sku ?? "").toLowerCase()) ??
      x.lines[index];
    // invoice_price is the net price the rules compared; a separate
    // invoice_net_price wins when the API sends one.
    const net = num(line.invoice_net_price ?? line.invoice_price);
    const po = num(line.po_price);
    if (net == null || po == null) return;
    const gross = inclusive ? (num(extracted?.unit_price) ?? net) : net;
    rows.push({
      sku: line.sku || extracted?.sku || extracted?.description || "Item",
      unit: line.unit || extracted?.unit || null,
      quantity: num(line.invoice_quantity) ?? num(extracted?.quantity) ?? 0,
      gross,
      net,
      po,
    });
  });
  const unitsUsed = new Set(x.lines.map((l) => (l.unit ?? "").toLowerCase()));
  return {
    count: x.lines.length,
    rows,
    totalQuantity: x.lines.reduce((sum, l) => sum + (num(l.quantity) ?? 0), 0),
    unit: unitsUsed.size === 1 ? x.lines[0].unit : null,
    inclusive,
    rate: rateNumber == null ? null : String(rateNumber),
    tax: cmp?.normalized?.tax ?? x.tax ?? null,
    matched: rows.length > 0 && rows.length >= x.lines.length,
    above: rows.filter((r) => r.net - r.po > 0.0001),
    below: rows.filter((r) => r.po - r.net > 0.0001),
  };
}

const pct = (r: LineRow) => (((r.net - r.po) / r.po) * 100).toFixed(1);
const per = (r: LineRow) => (r.unit ? ` per ${r.unit}` : "");
function totalUnits(f: LineFacts) {
  return f.unit ? units(f.totalQuantity, f.unit) : `${qty(f.totalQuantity)} items`;
}
function taxClause(f: LineFacts) {
  return f.inclusive && f.rate ? `${f.rate}% tax` : "tax";
}

/** Detail line for the "Lines match the order" step. */
export function linesStepText(f: LineFacts) {
  if (f.count > 1) {
    const price = !f.matched
      ? "matched to the order"
      : f.above.length
        ? "within price tolerance"
        : f.below.length
          ? "at or below the order prices"
          : "each at the order price";
    const tax = f.inclusive && f.rate ? ` · prices include ${f.rate}% tax` : "";
    return `${f.count} lines · ${totalUnits(f)} in total · ${price}${tax}`;
  }
  const r = f.rows[0];
  if (!r) return null;
  const head = `${r.sku} · ${units(r.quantity, r.unit)} at ${money(r.gross)}`;
  const net = f.inclusive ? ` incl. ${taxClause(f)} → ${money(r.net)} net` : "";
  if (r.net - r.po > 0.0001)
    return `${head}${net} · ${money(r.net - r.po)}${per(r)} (+${pct(r)}%) above the order price, inside the 1% and $1.00 limits`;
  if (r.po - r.net > 0.0001) return `${head}${net}, below the ${money(r.po)} order price`;
  return `${head}${net}, the order price`;
}

/** Why bullet for an approved invoice's lines. */
export function linesSentence(f: LineFacts) {
  if (f.count > 1) {
    const price = !f.matched
      ? "all matched to the order"
      : f.above.length
        ? `within price tolerance (${f.above.length} of ${f.count} above the order price)`
        : f.below.length
          ? "at or below the order prices"
          : "each at the order price";
    const tax =
      f.inclusive && f.rate ? `; prices include ${f.rate}% tax (${money(f.tax)})` : "";
    return `It bills ${f.count} lines, ${totalUnits(f)} in total, ${price}${tax}`;
  }
  const r = f.rows[0];
  if (!r) return null;
  const billed = units(r.quantity, r.unit);
  const versus =
    r.net - r.po > 0.0001
      ? `${money(r.net - r.po)}${per(r)} (+${pct(r)}%) above the order price, inside the 1% and $1.00 per-unit limits`
      : r.po - r.net > 0.0001
        ? `below the ${money(r.po)} order price`
        : "the order price";
  if (f.inclusive)
    return `It bills ${billed} at ${money(r.gross)}, which includes ${taxClause(f)} → ${money(r.net)} net, ${versus}; ${money(f.tax)} tax`;
  if (versus === "the order price")
    return `It bills ${billed} at ${money(r.net)}, exactly the order price`;
  return `It bills ${billed} at ${money(r.net)}, ${versus}`;
}

/** Summary when an approved invoice is above the order price but inside tolerance. */
export function toleranceSummary(f: LineFacts) {
  if (!f.above.length) return null;
  if (f.rows.length === 1) {
    const r = f.rows[0];
    const diff = r.net - r.po;
    return `Approved within price tolerance: ${money(diff)}${per(r)} (+${pct(r)}%) above the order price, inside the 1% and $1.00 per-unit limits (${money(diff * r.quantity)} in total).`;
  }
  const total = f.above.reduce((sum, r) => sum + (r.net - r.po) * r.quantity, 0);
  return `Approved within price tolerance: ${money(total)} above the order prices in total, every line inside the 1% and $1.00 per-unit limits.`;
}

/** The line furthest above its order price (for "price above tolerance"). */
export function worstPrice(f: LineFacts) {
  return [...f.above].sort((a, b) => (b.net - b.po) / b.po - (a.net - a.po) / a.po)[0] ?? null;
}

/** "$330.00 including 10% tax is $300.00 net" or just "$300.00". */
export function priceText(f: LineFacts, r: LineRow) {
  return f.inclusive
    ? `${money(r.gross)} including ${taxClause(f)} is ${money(r.net)} net`
    : money(r.net);
}

export { pct as linePercent };
