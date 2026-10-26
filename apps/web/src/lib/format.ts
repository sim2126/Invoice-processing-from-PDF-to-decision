/*
 * Display formatting only. Every business calculation (balances, tolerances,
 * decisions) is made by the API with Decimal; the UI sums cents for display.
 */
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function money(value?: string | number | null, currency = "USD") {
  if (value == null || value === "" || !Number.isFinite(Number(value)))
    return "—";
  if (currency !== "USD" && /^[A-Z]{3}$/.test(currency))
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(Number(value));
  return usd.format(Number(value));
}

/** Integer cents for display sums; unparseable values count as zero. */
export function cents(value?: string | number | null) {
  const n = Number(value);
  return value == null || value === "" || !Number.isFinite(n)
    ? 0
    : Math.round(n * 100);
}
export function moneyCents(value: number) {
  return usd.format(value / 100);
}

export function qty(value?: string | number | null) {
  const n = Number(value);
  if (value == null || value === "" || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
export function plural(unit: string | null | undefined, n: number) {
  if (!unit) return "";
  if (n === 1 || /s$/i.test(unit)) return unit;
  return `${unit}s`;
}
/** "45 cases", "1 hour", "2,000 brochures". */
export function units(quantity?: string | number | null, unit?: string | null) {
  const n = Number(quantity);
  return `${qty(quantity)} ${plural(unit, Number.isFinite(n) ? n : 0)}`.trim();
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar key in the viewer's time zone, e.g. "2026-10-27". */
export function dayKey(date: Date) {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}
/** Day key for an ISO date ("2026-10-26") or datetime. */
export function isoDayKey(value: string) {
  return DATE_ONLY.test(value) ? value : dayKey(new Date(value));
}
/** "Oct 26" for an ISO date or datetime; adds the year when it differs. */
export function dayLabel(value?: string | null, now?: number) {
  if (!value) return "—";
  const key = isoDayKey(value);
  const match = DATE_ONLY.exec(key);
  if (!match) return "—";
  const [, y, m, d] = match;
  const label = `${MONTHS[Number(m) - 1]} ${Number(d)}`;
  const year = now ? new Date(now).getFullYear() : Number(y);
  return Number(y) === year ? label : `${label}, ${y}`;
}
/** "Oct 26, 2026" for an ISO date or datetime. */
export function longDate(value?: string | null) {
  if (!value) return "—";
  const match = DATE_ONLY.exec(isoDayKey(value));
  if (!match) return value;
  const [, y, m, d] = match;
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}
export function clock(value: string) {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
/** "today 07:42" for today, otherwise "Oct 26". */
export function receivedLabel(value: string, now: number) {
  return isoDayKey(value) === dayKey(new Date(now))
    ? `today ${clock(value)}`
    : dayLabel(value, now);
}
/** "Oct 16, 15:40" (or "today 15:40"). */
export function moment(value: string, now: number) {
  return isoDayKey(value) === dayKey(new Date(now))
    ? `today ${clock(value)}`
    : `${dayLabel(value, now)}, ${clock(value)}`;
}
export function capitalize(text: string) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
export function firstWord(name?: string | null) {
  return (name || "").trim().split(/\s+/)[0] || "";
}
export function initials(name?: string | null) {
  return (name || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
/** Joins class names, skipping falsy values. */
export function cx(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(" ");
}
