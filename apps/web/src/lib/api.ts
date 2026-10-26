import type { components } from "./api.generated";

type Schemas = components["schemas"];

export type Session = Schemas["SessionResponse"];
export type Evidence = Schemas["EvidenceResponse"];
export type Extraction = Schemas["Extraction"];
export type ExtractedLine = Schemas["Line"];
export type RunEvent = Schemas["EventResponse"];
export type Audit = Schemas["AuditResponse"];
export type Comparison = Schemas["Comparison"];
export type Vendor = Schemas["VendorResponse"];
export type CandidateOrder = Schemas["POResponse"];
export type UploadResult = Schemas["UploadResponse"];
export type Supplier = Schemas["SupplierResponse"];
export type CompanyDocument = Schemas["DocumentResponse"];
export type ReviewRequest = Schemas["ReviewRequest"];
export type RetryRequest = Schemas["RetryRequest"];

/*
 * Tickmark contract additions. These are hand-written from the shared build
 * contract because the backend ships them in parallel; api.generated.ts is
 * intentionally not regenerated here.
 */
export type InvoiceStatus =
  | "CHECKING"
  | "FAILED"
  | "APPROVED"
  | "NEEDS_REVIEW"
  | "BLOCKED"
  | "ON_HOLD"
  | "REJECTED";
export type ReasonCode =
  | "nopo"
  | "budget"
  | "price"
  | "totals"
  | "duplicate"
  | "closed"
  | "inactive"
  | "nonumber"
  | "item"
  | "vendor"
  | "evidence"
  | "po"
  | "other";
export type Workflow = "ON_HOLD" | "REJECTED";
export type InvoiceSource = "upload" | "inbox" | "history";

export type InvoiceRow = Schemas["InvoiceRow"] & {
  vendor_id: string | null;
  invoice_date: string | null;
  due_date: string | null;
  due_assumed: boolean;
  status: InvoiceStatus;
  reason_code: ReasonCode | null;
  reason: string | null;
  first_reason_code: ReasonCode | null;
  first_reason: string | null;
  workflow: Workflow | null;
  workflow_to: string | null;
  workflow_note: string | null;
  workflow_by: string | null;
  workflow_at: string | null;
  source: InvoiceSource;
};

export type CheckGroup =
  | "document"
  | "supplier"
  | "po"
  | "lines"
  | "totals"
  | "duplicate"
  | "budget";
export type Check = Schemas["Check"] & { group: CheckGroup };
export type Decision = Omit<Schemas["DecisionResponse"], "checks"> & {
  checks: Check[];
  /*
   * Round-2 contract: why this decision is not approved (null when approved),
   * from the same reason_for() as rows. Not yet in docs/openapi.json.
   */
  reason_code: ReasonCode | null;
  reason: string | null;
};

/** Audit actions, including the round-2 AI assistant entries. */
export type AuditAction =
  | "UPLOAD"
  | "DECISION"
  | "REVIEW"
  | "RETRY"
  | "HOLD"
  | "REJECT"
  | "AI_MATCH"
  | "AI_NO_MATCH";
/** `after` of an AI_MATCH audit (actor "AI assistant"). */
export type AiMatchAfter = {
  po_reference: string;
  document: string;
  document_id: string;
};
/** `after` of an AI_NO_MATCH audit (actor "AI assistant"). */
export type AiNoMatchAfter = { documents_checked: number };
export type Detail = Omit<
  Schemas["DetailResponse"],
  "invoice" | "decision" | "history"
> & {
  invoice: InvoiceRow;
  decision: Decision | null;
  history: Decision[];
};
export type Queue = Omit<Schemas["QueueResponse"], "invoices"> & {
  invoices: InvoiceRow[];
};

/** Run event stages. `check:*` events carry the worst state of one check group. */
export type RunStage =
  | "intake"
  | "review"
  | "retry"
  | "read"
  | "extract"
  | "checks"
  | "assist"
  | "decision"
  | "recovery"
  | "processing"
  | `check:${CheckGroup}`;

export type HoldRequest = {
  expected_revision: number;
  to: string;
  message: string;
};
export type RejectRequest = { expected_revision: number; reason: string };

export type PurchaseOrderLine = {
  sku: string;
  description: string;
  unit: string;
  unit_price: string;
  quantity: string;
  committed_quantity: string;
  remaining_quantity: string;
};
export type PurchaseOrder = {
  id: string;
  reference: string;
  description: string;
  status: "ACTIVE" | "CLOSED";
  currency: string;
  vendor: { id: string; name: string; identifier: string; active: boolean };
  ceiling: string;
  committed: string;
  remaining: string;
  lines: PurchaseOrderLine[];
};

export type InboxItem = {
  key: string;
  kind: "invoice" | "document";
  sender: string;
  subject: string;
  received_at: string;
  filename: string;
  invoice_id: string | null;
  document_id: string | null;
};

/** `decision.assistant` is a free-form object in the generated schema. */
export type AssistantSource = {
  id: string;
  title: string;
  kind: "invoice" | "order" | "document" | "policy" | "checks";
  page?: number | null;
  document_id?: string | null;
  quote: string;
};
export type Assistance = {
  status?: "ready" | "unavailable" | "disabled" | "imported";
  explanation?: string;
  next_step?: string;
  question?: string | null;
  draft_message?: string | null;
  suggested_po_id?: string | null;
  auto_matched?: boolean;
  sources?: AssistantSource[];
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(
      typeof error.detail === "string"
        ? error.detail
        : "Please check the form and try again.",
      response.status,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export function mutation(csrf: string, value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(value),
  };
}
/** A CSRF-protected POST without a body (inbox check / save). */
export function action(csrf: string): RequestInit {
  return { method: "POST", headers: { "X-CSRF-Token": csrf } };
}
/** Multipart upload of one PDF; the browser sets the boundary header. */
export function fileUpload(csrf: string, file: File): RequestInit {
  const body = new FormData();
  body.append("file", file);
  return { method: "POST", headers: { "X-CSRF-Token": csrf }, body };
}
export function removal(csrf: string): RequestInit {
  return { method: "DELETE", headers: { "X-CSRF-Token": csrf } };
}
let boot: Promise<Session> | null = null;
export function getSession() {
  if (!boot)
    boot = api<Session>("/session")
      .catch(async (error) => {
        if (
          error instanceof ApiError &&
          error.status === 401 &&
          !sessionStorage.getItem("ap_started")
        ) {
          const session = await api<Session>("/session", { method: "POST" });
          sessionStorage.setItem("ap_started", "1");
          return session;
        }
        throw error;
      })
      .finally(() => {
        boot = null;
      });
  return boot;
}
