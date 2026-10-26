"use client";
import type { InvoiceRow } from "@/lib/api";
import { money } from "@/lib/format";
import { useInvoices, usePurchaseOrders, useSuppliers } from "@/lib/queries";
import { isOpen } from "@/lib/status";
import { ErrorNotice, Loading, Pill } from "./ui";

/** Supplier names as printed vary ("Alder Office Supply LLC"); compare loosely. */
function normalise(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(llc|inc|co|ltd|corp|company)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function sameSupplier(row: InvoiceRow, id: string, name: string) {
  // Decided invoices carry the matched supplier; fall back to the printed name.
  if (row.vendor_id) return row.vendor_id === id;
  if (!row.vendor) return false;
  const a = normalise(row.vendor);
  const b = normalise(name);
  return !!a && !!b && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `));
}

export function Suppliers() {
  const suppliers = useSuppliers();
  const orders = usePurchaseOrders();
  const invoices = useInvoices();
  const rows = invoices.data?.invoices ?? [];
  return (
    <div className="tm-view">
      <div className="tm-head">
        <div>
          <h1>Suppliers</h1>
          <p>Who you buy from, whether they can be paid, and what is open with each.</p>
        </div>
      </div>
      <section className="tm-card tm-grow" aria-label="Suppliers">
        <div
          className="tm-card-b tm-xscroll"
          tabIndex={0}
          role="region"
          aria-label="Supplier list, scrollable"
        >
          {suppliers.isPending ? (
            <Loading label="Loading suppliers…" />
          ) : suppliers.error && !suppliers.data ? (
            <div className="tm-pad">
              <ErrorNotice error={suppliers.error} onRetry={() => suppliers.refetch()} />
            </div>
          ) : (
            <div className="tm-table tm-rows-wide" role="table" aria-label="Suppliers">
              <div className="tm-row tm-thead tm-cols-sup" role="row">
                <span role="columnheader">Supplier</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Open orders</span>
                <span role="columnheader" className="tm-r">
                  Approved value
                </span>
                <span role="columnheader">Open invoices</span>
              </div>
              {(suppliers.data ?? []).map((supplier) => {
                const open = (orders.data ?? [])
                  .filter((o) => o.vendor.id === supplier.id && o.status === "ACTIVE")
                  .map((o) => o.reference);
                const waiting = rows.filter(
                  (r) => isOpen(r.status) && sameSupplier(r, supplier.id, supplier.name),
                ).length;
                return (
                  <div className="tm-row tm-cols-sup" role="row" key={supplier.id}>
                    <span role="cell" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                      <span style={{ fontWeight: 550 }}>{supplier.name}</span>
                      <span className="tm-faint tm-mono" style={{ fontSize: 12 }}>
                        {supplier.identifier}
                      </span>
                    </span>
                    <span role="cell">
                      <Pill tone={supplier.active ? "is-approved" : ""}>
                        {supplier.active ? "Approved" : "Inactive"}
                      </Pill>
                    </span>
                    <span role="cell" className="tm-mono tm-muted" style={{ fontSize: 12.5 }}>
                      {orders.data ? (open.length ? open.join(", ") : "None open") : "—"}
                    </span>
                    <span role="cell" className="tm-r tm-num">
                      {money(supplier.approved_value)}
                    </span>
                    <span role="cell" className="tm-muted" style={{ fontSize: 13 }}>
                      {waiting
                        ? `${waiting} ${waiting === 1 ? "needs" : "need"} attention`
                        : "Nothing open"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
