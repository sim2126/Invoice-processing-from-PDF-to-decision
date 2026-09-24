"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, FileText, Search } from "lucide-react";
import {
  api,
  amount,
  type Session,
  type Supplier,
  type SupplierDetail,
} from "@/lib/api";
import { Dialog, DialogContent } from "../ui/dialog";
import { Badge, ErrorNotice, status } from "../common";
import { Pending, PageHeading } from "./shared";

export function Suppliers({ session }: { session: Session }) {
  const query = useQuery({
    queryKey: ["suppliers", session.workspace],
    queryFn: () => api<Supplier[]>("/suppliers"),
    refetchInterval: 10000,
  });
  const [search, setSearch] = useState("");
  const [attention, setAttention] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState("attention");
  const detail = useQuery({
    queryKey: ["supplier", selected],
    queryFn: () => api<SupplierDetail>(`/suppliers/${selected}`),
    enabled: !!selected,
  });
  const rows = (query.data || [])
    .filter(
      (s) =>
        (!attention || s.needs_attention > 0) &&
        `${s.name} ${s.identifier}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "value"
          ? Number(b.invoice_value) - Number(a.invoice_value)
          : b.needs_attention - a.needs_attention ||
            a.name.localeCompare(b.name),
    );
  return (
    <div className="product-page">
      <PageHeading
        title="Suppliers"
        description="Your supplier relationships, purchase orders, and invoices in one place."
      />
      <div className="product-toolbar">
        <div
          className="product-tabs"
          role="group"
          aria-label="Filter suppliers"
        >
          <button aria-pressed={!attention} onClick={() => setAttention(false)}>
            All <span>{query.data?.length || 0}</span>
          </button>
          <button aria-pressed={attention} onClick={() => setAttention(true)}>
            Needs attention{" "}
            <span>
              {query.data?.filter((s) => s.needs_attention).length || 0}
            </span>
          </button>
        </div>
        <label className="searchbox">
          <Search size={18} />
          <input
            aria-label="Search suppliers"
            placeholder="Search suppliers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <label className="product-sort">
        Sort by{" "}
        <select
          aria-label="Sort suppliers"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="attention">Needs attention</option>
          <option value="value">Invoice value</option>
          <option value="name">Supplier name</option>
        </select>
      </label>
      <ErrorNotice error={query.error} />
      {query.isPending ? (
        <Pending />
      ) : (
        <div className="table-scroll">
          <table className="directory-table">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Invoice value</th>
                <th>Needs attention</th>
                <th>Open POs</th>
                <th>
                  <span className="sr-only">View supplier</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    <button
                      className="supplier-name"
                      onClick={() => setSelected(s.id)}
                    >
                      {s.name}
                    </button>
                    <small>
                      {s.identifier}
                      {!s.active && " · Inactive"}
                    </small>
                  </td>
                  <td>
                    <strong>{amount(s.invoice_value)}</strong>
                    <small>{s.invoice_count} invoices</small>
                  </td>
                  <td>
                    <span
                      className={s.needs_attention ? "attention-text" : "muted"}
                    >
                      {s.needs_attention} of {s.invoice_count}
                    </span>
                  </td>
                  <td>{s.open_orders}</td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`View ${s.name}`}
                      onClick={() => setSelected(s.id)}
                    >
                      <ArrowUpRight size={19} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <div className="product-empty">No suppliers match this view.</div>
          )}
        </div>
      )}
      <p className="product-footnote">
        Invoice value includes reviewed invoices. Approved amounts are
        commitments, not payments.
      </p>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent
          className="supplier-dialog"
          title={detail.data?.supplier.name || "Supplier"}
          description="Purchase orders and current invoice records."
        >
          {detail.isPending ? (
            <Pending />
          ) : (
            detail.data && (
              <>
                <div className="supplier-summary">
                  <div>
                    <small>Invoice value</small>
                    <strong>
                      {amount(detail.data.supplier.invoice_value)}
                    </strong>
                  </div>
                  <div>
                    <small>Accepted commitments</small>
                    <strong>
                      {amount(detail.data.supplier.committed_value)}
                    </strong>
                  </div>
                  <div>
                    <small>Needs attention</small>
                    <strong>{detail.data.supplier.needs_attention}</strong>
                  </div>
                </div>
                <h3>Purchase orders</h3>
                <div className="record-list">
                  {detail.data.orders.map((po) => (
                    <div className="record-row" key={po.id}>
                      <FileText size={20} />
                      <div>
                        <strong>
                          {po.reference} · {po.description}
                        </strong>
                        <small>
                          {po.status.toLowerCase()} · Ceiling{" "}
                          {amount(po.ceiling)}
                        </small>
                      </div>
                    </div>
                  ))}
                </div>
                <h3>Invoices</h3>
                <div className="record-list">
                  {detail.data.invoices.map((i) => (
                    <Link
                      className="record-row"
                      href={`/invoices/${i.id}`}
                      key={i.id}
                    >
                      <div>
                        <strong>{i.reference || i.filename}</strong>
                        <small>
                          {amount(i.total)} · {i.summary}
                        </small>
                      </div>
                      <Badge state={status(i)} />
                      <ArrowUpRight size={17} />
                    </Link>
                  ))}
                  {!detail.data.invoices.length && (
                    <p className="form-hint">
                      No invoices processed for this supplier yet.
                    </p>
                  )}
                </div>
              </>
            )
          )}
          <ErrorNotice error={detail.error} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
