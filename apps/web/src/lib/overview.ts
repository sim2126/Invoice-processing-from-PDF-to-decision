import type { InvoiceRow, ReasonCode } from "./api";
import { cents, dayKey, dayLabel, isoDayKey, moneyCents } from "./format";
import { isDecided, isOpen, reasonText } from "./status";

/** Outcome buckets used by the weekly chart. */
export type Outcome = "auto" | "person" | "blocked";

export function outcomeOf(row: InvoiceRow): Outcome {
  if (row.status === "BLOCKED") return "blocked";
  if (row.status === "APPROVED" && !row.human_touched) return "auto";
  return "person";
}

const byNewest = (a: InvoiceRow, b: InvoiceRow) =>
  Date.parse(b.created_at) - Date.parse(a.created_at);

export function decidedRows(rows: InvoiceRow[]) {
  return rows.filter((r) => isDecided(r.status)).sort(byNewest);
}

/** Blocked for a reason a person can still act on (not duplicates). */
export function needsAction(row: InvoiceRow) {
  return (
    isOpen(row.status) ||
    (row.status === "BLOCKED" &&
      (row.reason_code === "inactive" || row.reason_code === "closed"))
  );
}

/**
 * NEEDS_REVIEW, ON_HOLD and actionable BLOCKED invoices, soonest due first
 * (unknown due dates last).
 */
export function actionRows(rows: InvoiceRow[]) {
  return rows
    .filter(needsAction)
    .sort((a, b) => {
      if (a.due_date && b.due_date && a.due_date !== b.due_date)
        return a.due_date < b.due_date ? -1 : 1;
      if (!!a.due_date !== !!b.due_date) return a.due_date ? -1 : 1;
      return Date.parse(a.created_at) - Date.parse(b.created_at);
    });
}

export type Kpi = { label: string; value: string; sub: string };

const BLOCKED_PHRASE: Partial<Record<ReasonCode, string>> = {
  duplicate: "duplicates",
  closed: "closed orders",
  inactive: "inactive suppliers",
  vendor: "unknown suppliers",
};

export function overviewSummary(rows: InvoiceRow[], now: number) {
  const decided = decidedRows(rows);
  const total = decided.reduce((sum, r) => sum + cents(r.total), 0);
  const auto = decided.filter((r) => outcomeOf(r) === "auto").length;
  const review = decided.filter((r) => r.status === "NEEDS_REVIEW");
  const blocked = decided.filter((r) => r.status === "BLOCKED");
  const since = decided.length
    ? decided[decided.length - 1].created_at
    : null;
  // Distinct matched suppliers; an unmatched invoice counts by printed name.
  const suppliers = new Set(
    decided
      .map((r) => r.vendor_id ?? (r.vendor ? `name:${r.vendor.trim().toLowerCase()}` : ""))
      .filter(Boolean),
  ).size;

  const phrases: string[] = [];
  for (const row of blocked) {
    const phrase =
      (row.reason_code && BLOCKED_PHRASE[row.reason_code]) ||
      reasonText(row.reason_code, row.reason)?.toLowerCase();
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }

  const kpis: Kpi[] = [
    {
      label: "Invoices processed",
      value: String(decided.length),
      sub: since
        ? `${moneyCents(total)} billed since ${dayLabel(since, now)}`
        : "Nothing processed yet",
    },
    {
      label: "Approved automatically",
      value: decided.length
        ? `${Math.round((auto / decided.length) * 100)}%`
        : "—",
      sub: `${auto} of ${decided.length} with no one involved`,
    },
    {
      label: "Needs your review",
      value: String(review.length),
      sub: `${moneyCents(review.reduce((s, r) => s + cents(r.total), 0))} waiting on a decision`,
    },
    {
      label: "Stopped before payment",
      value: moneyCents(blocked.reduce((s, r) => s + cents(r.total), 0)),
      sub: blocked.length
        ? `${blocked.length} blocked${phrases.length ? `: ${phrases.join(", ")}` : ""}`
        : "Nothing blocked",
    },
  ];
  return { decided, kpis, since, suppliers };
}

export type Week = {
  label: string;
  range: string;
  auto: number;
  person: number;
  blocked: number;
  total: number;
};

/** Monday-start calendar weeks: the last six, ending with the current week. */
export function weekWindow(now: number) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return Array.from({ length: 6 }, (_, i) => {
    const start = new Date(monday);
    start.setDate(monday.getDate() - (5 - i) * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start: dayKey(start), end: dayKey(end) };
  });
}

export function outcomesByWeek(rows: InvoiceRow[], now: number): Week[] {
  const window = weekWindow(now);
  const weeks = window.map((w, i) => ({
    label: i === 5 ? "This week" : dayLabel(w.start, now),
    range:
      i === 5
        ? `${dayLabel(w.start, now)} – today`
        : `${dayLabel(w.start, now)} – ${dayLabel(w.end, now)}`,
    auto: 0,
    person: 0,
    blocked: 0,
    total: 0,
  }));
  for (const row of rows) {
    if (!isDecided(row.status)) continue;
    const day = isoDayKey(row.created_at);
    const index = window.findIndex((w) => day >= w.start && day <= w.end);
    if (index < 0) continue;
    weeks[index][outcomeOf(row)] += 1;
    weeks[index].total += 1;
  }
  return weeks;
}

/** Counts of each invoice's first exception within the six-week window. */
export function stopReasons(rows: InvoiceRow[], now: number) {
  const window = weekWindow(now);
  const first = window[0].start;
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isDecided(row.status) || isoDayKey(row.created_at) < first) continue;
    const label = reasonText(row.first_reason_code, row.first_reason);
    if (label) counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function blockedTotal(rows: InvoiceRow[], now: number) {
  const first = weekWindow(now)[0].start;
  const blocked = rows.filter(
    (r) => r.status === "BLOCKED" && isoDayKey(r.created_at) >= first,
  );
  return {
    count: blocked.length,
    amount: moneyCents(blocked.reduce((s, r) => s + cents(r.total), 0)),
  };
}
