"use client";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { type Invoice } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  CircleX,
  Clock3,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";

export const statusLabels: Record<string, string> = {
  APPROVED: "Approved",
  NEEDS_REVIEW: "Review required",
  BLOCKED: "Blocked",
  FAILED: "Processing failed",
  QUEUED: "Queued",
  RUNNING: "Processing",
};

export function StateIcon({
  state,
  size = 14,
}: {
  state: string;
  size?: number;
}) {
  if (["APPROVED", "passed"].includes(state))
    return <CheckCircle2 size={size} />;
  if (["NEEDS_REVIEW", "review"].includes(state))
    return <CircleAlert size={size} />;
  if (["BLOCKED", "FAILED", "blocked", "failed"].includes(state))
    return <CircleX size={size} />;
  return ["RUNNING", "running"].includes(state) ? (
    <LoaderCircle className="spin" size={size} />
  ) : (
    <Clock3 size={size} />
  );
}

export function status(invoice: Invoice) {
  return invoice.execution === "COMPLETED"
    ? invoice.outcome || "QUEUED"
    : invoice.execution;
}

export function Badge({ state }: { state: string }) {
  return (
    <span className={cn("badge", `status-${state.toLowerCase()}`)}>
      <StateIcon state={state} />
      {statusLabels[state] || state}
    </span>
  );
}

export function ErrorNotice({ error }: { error: Error | null }) {
  return error ? (
    <div className="error-notice" role="alert">
      <CircleAlert size={17} />
      <span>{error.message}</span>
    </div>
  ) : null;
}

export function Policy({ children }: { children?: React.ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {children || (
          <button className="text-button">
            <ShieldCheck size={15} /> Policy AP-2026.1{" "}
            <ArrowUpRight size={13} />
          </button>
        )}
      </DialogTrigger>
      <DialogContent
        title="A clear, consistent policy"
        description="AP-2026.1 · Fictional Northstar Studio · USD · Two-way matching"
      >
        <div className="policy-list">
          <div>
            <strong>Evidence before approval</strong>
            <p>
              Required identity, date, currency, amounts and line fields need
              source evidence. Ambiguity goes to review.
            </p>
          </div>
          <div>
            <strong>One PO, one accepted commitment</strong>
            <p>
              Gross amount and cumulative quantities must fit the remaining
              order. Previously paid invoices already count once.
            </p>
          </div>
          <div>
            <strong>Small tolerances, firm ceilings</strong>
            <p>
              Arithmetic difference: at most $0.01. Upward price variance: both
              ≤1% and ≤$1 per unit. Neither increases the PO ceiling.
            </p>
          </div>
          <div>
            <strong>A human can resolve, never override</strong>
            <p>
              Corrections require source evidence and a reason. All checks
              rerun. Accepted invoices need an external reversal process.
            </p>
          </div>
          <div>
            <strong>Approval is the next AP step</strong>
            <p>
              This does not pay a vendor, confirm delivery, validate statutory
              tax, or perform three-way matching.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function Metric({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        {icon}
      </div>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}
