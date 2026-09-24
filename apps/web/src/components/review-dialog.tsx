"use client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  api,
  fieldValue,
  mutation,
  type Detail,
  type Session,
  type UploadResult,
  type Assistance,
} from "@/lib/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ChevronDown,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { ErrorNotice } from "./common";

export const reviewSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(8, "Add a reason with at least 8 characters."),
    po: z.string(),
    vendor: z.string(),
    field: z.string(),
    value: z.string(),
    source: z.string(),
    page: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.field && (!v.value.trim() || !v.source.trim()))
      ctx.addIssue({
        code: "custom",
        message: "A correction needs the new value and supporting source text.",
        path: ["source"],
      });
  });

export type ReviewForm = z.infer<typeof reviewSchema>;

export function ReviewDialog({
  open,
  setOpen,
  data,
  session,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  data: Detail;
  session: Session;
}) {
  const client = useQueryClient();
  const assistance = data.decision?.assistant as Assistance | undefined;
  const form = useForm<ReviewForm>({
    resolver: zodResolver(reviewSchema),
    defaultValues: {
      reason: "",
      po: "",
      vendor: "",
      field: "",
      value: "",
      source: "",
      page: "1",
    },
  });
  const selectedField = useWatch({ control: form.control, name: "field" }),
    newValue = useWatch({ control: form.control, name: "value" });
  const review = useMutation({
    mutationFn: (v: ReviewForm) =>
      api<UploadResult>(
        `/invoices/${data.invoice.id}/review`,
        mutation(session.csrf, {
          expected_revision: data.invoice.revision,
          reason: v.reason,
          po_id: v.po || null,
          vendor_id: v.vendor || null,
          corrections: v.field
            ? [
                {
                  field: v.field,
                  value: v.value,
                  page: Number(v.page),
                  source_text: v.source,
                },
              ]
            : [],
        }),
      ),
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ["invoice", data.invoice.id],
      });
      await client.invalidateQueries({ queryKey: ["queue"] });
      setOpen(false);
      form.reset();
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!review.isPending) setOpen(next);
      }}
    >
      <DialogContent
        title="Review & resolve"
        description={`Revision ${data.invoice.revision} · Your changes create a new revision. Every dependent check runs again.`}
      >
        <form
          onSubmit={form.handleSubmit((v) => review.mutate(v))}
          className="review-form"
        >
          {assistance?.status === "ready" && assistance.question && (
            <div className="assistant-question">
              <strong>AI has narrowed this down</strong>
              <p>{assistance.question}</p>
            </div>
          )}
          <label>
            Confirm purchase order
            <select
              {...form.register("po", {
                onChange: (event) => {
                  const po = data.candidates.orders.find(
                    (p) => p.id === event.target.value,
                  );
                  if (po)
                    form.setValue(
                      "reason",
                      `Confirmed ${po.reference} (${po.description}) for this invoice after reviewing the project assignment.`,
                      { shouldValidate: true },
                    );
                },
              })}
            >
              <option value="">Keep current match</option>
              {data.candidates.orders.map((po) => (
                <option key={po.id} value={po.id}>
                  {po.reference} · {po.description}
                </option>
              ))}
            </select>
          </label>
          <details className="correction-options">
            <summary>
              Correct vendor or extracted field
              <ChevronDown size={15} />
            </summary>
            <label>
              Verified vendor
              <select {...form.register("vendor")}>
                <option value="">Keep current vendor</option>
                {data.candidates.vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {!v.active ? " · inactive" : ""}
                  </option>
                ))}
              </select>
            </label>
            <p className="form-hint">
              Changing the vendor rechecks all matches. If needed, choose its PO
              after the new checks finish.
            </p>
            <label>
              Field to correct
              <select {...form.register("field")}>
                <option value="">No field correction</option>
                {[
                  "total",
                  "subtotal",
                  "tax",
                  "shipping",
                  "header_discount",
                  "invoice_number",
                  "invoice_date",
                  "currency",
                  "po_reference",
                  "vendor_name",
                  "vendor_identifier",
                  ...(data.extraction?.lines.flatMap((_, i) =>
                    ["quantity", "unit_price", "total", "sku", "unit"].map(
                      (f) => `lines.${i}.${f}`,
                    ),
                  ) || []),
                ].map((field) => (
                  <option value={field} key={field}>
                    {field.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            {selectedField && (
              <>
                <label>
                  Correct source value
                  <input {...form.register("value")} autoComplete="off" />
                </label>
                <div className="correction-diff">
                  <span>
                    Before{" "}
                    <del>
                      {fieldValue(data.extraction, selectedField) ||
                        "Not stated"}
                    </del>
                  </span>
                  <ArrowRight size={14} />
                  <span>
                    After <ins>{newValue || "Enter a value"}</ins>
                  </span>
                </div>
                <div className="source-form-row">
                  <label>
                    Source page
                    <select {...form.register("page")}>
                      {Array.from({ length: data.pages }, (_, i) => (
                        <option value={i + 1} key={i}>
                          {i + 1}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Exact supporting source text
                    <input
                      {...form.register("source")}
                      placeholder="e.g. Total USD: 1,200.00"
                    />
                  </label>
                </div>
                {form.formState.errors.source && (
                  <p className="form-error">
                    {form.formState.errors.source.message}
                  </p>
                )}
                <p className="form-hint">
                  Correct extraction to match the document. If printed amounts
                  conflict, request a corrected invoice from the vendor.
                </p>
              </>
            )}
          </details>
          <label>
            Reason for this review
            <textarea
              {...form.register("reason")}
              rows={3}
              placeholder="Explain what you confirmed and why…"
              aria-invalid={!!form.formState.errors.reason}
            />
          </label>
          {form.formState.errors.reason && (
            <p className="form-error" role="alert">
              {form.formState.errors.reason.message}
            </p>
          )}
          <div className="privacy-note">
            <ShieldCheck size={16} />
            <span>
              PO limits and required checks still apply. This action cannot
              override a blocker.
            </span>
          </div>
          <ErrorNotice error={review.error} />
          <div className="dialog-actions">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={review.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={review.isPending}>
              {review.isPending ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <RotateCcw size={16} />
              )}
              Run checks again
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
