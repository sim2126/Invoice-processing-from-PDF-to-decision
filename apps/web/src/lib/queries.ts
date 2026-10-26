import {
  queryOptions,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import {
  api,
  type CompanyDocument,
  type Detail,
  type InboxItem,
  type InvoiceRow,
  type InvoiceStatus,
  type PurchaseOrder,
  type Queue,
  type Supplier,
} from "./api";

/**
 * The API computes `status`. This only covers a response that predates the
 * field, so lists never render without a status during an upgrade.
 */
function withStatus(row: InvoiceRow): InvoiceRow {
  if (row.status) return row;
  const status: InvoiceStatus =
    row.execution === "QUEUED" || row.execution === "RUNNING"
      ? "CHECKING"
      : row.execution === "FAILED"
        ? "FAILED"
        : row.decision_applicable && row.outcome
          ? (row.outcome as InvoiceStatus)
          : "CHECKING";
  return { ...row, status, source: row.source ?? "upload" };
}

export const keys = {
  invoices: ["invoices"] as const,
  invoice: (id: string) => ["invoice", id] as const,
  inbox: ["inbox"] as const,
  purchaseOrders: ["purchase-orders"] as const,
  suppliers: ["suppliers"] as const,
  documents: ["documents"] as const,
};

export function useInvoices(enabled = true) {
  return useQuery({
    queryKey: keys.invoices,
    queryFn: async () => {
      const queue = await api<Queue>("/invoices");
      return { ...queue, invoices: queue.invoices.map(withStatus) };
    },
    enabled,
    // Faster while anything is being checked so outcomes land promptly.
    refetchInterval: (query) =>
      query.state.data?.invoices.some((i) => i.status === "CHECKING")
        ? 2500
        : 15000,
  });
}

export function useInbox() {
  return useQuery({
    queryKey: keys.inbox,
    queryFn: () => api<InboxItem[]>("/inbox"),
  });
}

export function usePurchaseOrders() {
  return useQuery({
    queryKey: keys.purchaseOrders,
    queryFn: () => api<PurchaseOrder[]>("/purchase-orders"),
  });
}

export function useSuppliers() {
  return useQuery({
    queryKey: keys.suppliers,
    queryFn: () => api<Supplier[]>("/suppliers"),
  });
}

/** Supplier record names by id, for showing a matched supplier's own name. */
export function useSupplierNames() {
  const suppliers = useSuppliers();
  return new Map((suppliers.data ?? []).map((s) => [s.id, s.name]));
}

export function useDocuments() {
  return useQuery({
    queryKey: keys.documents,
    queryFn: () => api<CompanyDocument[]>("/documents"),
  });
}

export function detailOptions(id: string) {
  return queryOptions({
    queryKey: keys.invoice(id),
    queryFn: async () => {
      const detail = await api<Detail>(`/invoices/${encodeURIComponent(id)}`);
      return { ...detail, invoice: withStatus(detail.invoice) };
    },
  });
}

/** Everything a new decision can change: lists, balances and suppliers. */
export function refreshWorkspace(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: keys.invoices }),
    client.invalidateQueries({ queryKey: keys.inbox }),
    client.invalidateQueries({ queryKey: keys.purchaseOrders }),
    client.invalidateQueries({ queryKey: keys.suppliers }),
  ]);
}
