import type { components } from "./api.generated";
export type Session = components["schemas"]["SessionResponse"];
export type Invoice = components["schemas"]["InvoiceRow"];
export type Queue = components["schemas"]["QueueResponse"];
export type Detail = components["schemas"]["DetailResponse"];
export type Evidence = components["schemas"]["EvidenceResponse"];
export type Review = components["schemas"]["ReviewRequest"];
export type UploadResult = components["schemas"]["UploadResponse"];
export type Scenario = {
  id: string;
  title: string;
  description: string;
  file: string;
  expected: string;
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
  return response.json();
}
export function mutation(csrf: string, value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(value),
  };
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
export function amount(value?: string | null, currency = "USD") {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  // Formatting only; every business calculation is done by FastAPI with Decimal.
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD",
  }).format(Number(value));
}
export function stamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
export function fieldValue(data: Detail["extraction"], path: string): string {
  if (!data) return "";
  if (path.startsWith("lines.")) {
    const [, index, field] = path.split(".");
    return String(
      data.lines[Number(index)]?.[field as keyof (typeof data.lines)[number]] ??
        "",
    );
  }
  return String(data[path as keyof typeof data] ?? "");
}
