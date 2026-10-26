"use client";
import { useEffect, useSyncExternalStore } from "react";
import { cx, money, plural, qty } from "@/lib/format";
import { usePurchaseOrders } from "@/lib/queries";
import { ErrorNotice, Loading, Pill } from "./ui";

function subscribeHash(listener: () => void) {
  window.addEventListener("hashchange", listener);
  window.addEventListener("popstate", listener);
  return () => {
    window.removeEventListener("hashchange", listener);
    window.removeEventListener("popstate", listener);
  };
}

export function PurchaseOrders() {
  const orders = usePurchaseOrders();
  // "View purchase order" links here with #PO-1120 to point at one order.
  const hash = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => "",
  );
  const target = decodeURIComponent(hash.replace(/^#/, ""));
  const loaded = !!orders.data;
  useEffect(() => {
    if (!target || !loaded) return;
    document
      .getElementById(`po-${target}`)
      ?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [target, loaded]);

  return (
    <div className="tm-view">
      <div className="tm-head">
        <div>
          <h1>Purchase orders</h1>
          <p>
            What each order allows, what has been billed against it, and what is
            left. Budget is reserved only when an invoice is approved.
          </p>
        </div>
      </div>
      <section className="tm-card tm-grow" aria-label="Purchase orders">
        <div
          className="tm-card-b tm-xscroll"
          tabIndex={0}
          role="region"
          aria-label="Purchase order list, scrollable"
        >
          {orders.isPending ? (
            <Loading label="Loading purchase orders…" />
          ) : orders.error && !orders.data ? (
            <div className="tm-pad">
              <ErrorNotice error={orders.error} onRetry={() => orders.refetch()} />
            </div>
          ) : (
            <div
              className="tm-table tm-rows-wide"
              role="table"
              aria-label="Purchase orders"
              style={{ minWidth: 900 }}
            >
              <div className="tm-row tm-thead tm-cols-po" role="row">
                <span role="columnheader">Order</span>
                <span role="columnheader">Supplier</span>
                <span role="columnheader">Status</span>
                <span role="columnheader" className="tm-r">
                  Limit
                </span>
                <span role="columnheader" className="tm-r">
                  Billed
                </span>
                <span role="columnheader">Left</span>
                <span role="columnheader">Line item</span>
              </div>
              {(orders.data ?? []).map((order) => {
                const ceiling = Number(order.ceiling);
                const used =
                  ceiling > 0
                    ? Math.min(100, Math.round((Number(order.committed) / ceiling) * 100))
                    : 0;
                return (
                  <div
                    className={cx("tm-row tm-cols-po", order.reference === target && "is-target")}
                    role="row"
                    id={`po-${order.reference}`}
                    key={order.id}
                  >
                    <span role="cell" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                      <span className="tm-cell-id">{order.reference}</span>
                      <span className="tm-faint tm-ellipsis" style={{ fontSize: 12 }}>
                        {order.description}
                      </span>
                    </span>
                    <span role="cell" className="tm-ellipsis">
                      {order.vendor.name}
                    </span>
                    <span role="cell">
                      <Pill tone={order.status === "ACTIVE" ? "" : "is-hold"}>
                        {order.status === "ACTIVE" ? "Open" : "Closed"}
                      </Pill>
                    </span>
                    <span role="cell" className="tm-r tm-num">
                      {money(order.ceiling, order.currency)}
                    </span>
                    <span role="cell" className="tm-r tm-num">
                      {money(order.committed, order.currency)}
                    </span>
                    <span role="cell" style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                      {order.status === "CLOSED" ? (
                        // A closed order takes no more invoices, whatever its balance.
                        <span className="tm-muted" style={{ fontWeight: 550 }}>
                          Closed
                        </span>
                      ) : (
                        <>
                          <span className="tm-num" style={{ fontWeight: 550 }}>
                            {money(order.remaining, order.currency)}
                          </span>
                          <span
                            className="tm-meter"
                            style={{ height: 6 }}
                            role="img"
                            aria-label={`${used} percent used`}
                          >
                            <span style={{ width: `${used}%`, background: "var(--bar)" }} />
                          </span>
                        </>
                      )}
                    </span>
                    <span role="cell" className="tm-muted" style={{ fontSize: 12.5 }}>
                      {order.lines.map((line) => (
                        <span key={line.sku} style={{ display: "block" }}>
                          <span className="tm-mono">{line.sku}</span> ·{" "}
                          {order.status === "CLOSED"
                            ? `${qty(line.quantity)} ${plural(line.unit, Number(line.quantity))} ordered`
                            : `${qty(line.remaining_quantity)} of ${qty(line.quantity)} ${plural(line.unit, Number(line.quantity))} left`}
                        </span>
                      ))}
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
