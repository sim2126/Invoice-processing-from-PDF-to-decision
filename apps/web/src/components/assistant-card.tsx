"use client";
import { useState } from "react";
import { Check, Copy, Sparkles, ArrowUpRight } from "lucide-react";
import { type Assistance } from "@/lib/api";
import { Button } from "./ui/button";

export function AssistantCard({
  assistance,
  invoiceId,
}: {
  assistance: unknown;
  invoiceId: string;
}) {
  const data = assistance as Assistance | undefined;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  if (!data?.status) return null;
  return (
    <section className="assistant-card" aria-label="AI review assistance">
      <div className="assistant-heading">
        <Sparkles size={19} />
        <h3>AI review assistant</h3>
        {data.auto_matched && (
          <span className="auto-match-label">PO matched from evidence</span>
        )}
      </div>
      {data.status !== "ready" ? (
        <p>
          {data.status === "disabled"
            ? "AI assistance is off in company settings. Invoice extraction and policy checks still run."
            : "AI assistance was unavailable for this run. The decision above uses the recorded policy checks."}
        </p>
      ) : (
        <>
          <p>{data.explanation}</p>
          {data.question && (
            <div className="assistant-question">
              <strong>One detail to confirm</strong>
              <p>{data.question}</p>
            </div>
          )}
          {data.next_step && (
            <p>
              <strong>Next step: </strong>
              {data.next_step}
            </p>
          )}
          {!!data.sources?.length && (
            <details className="assistant-sources">
              <summary>
                Sources used <span>{data.sources.length}</span>
              </summary>
              {data.sources.map((s, i) => (
                <div className="assistant-citation" key={`${s.id}-${i}`}>
                  <strong>
                    {s.title}
                    {s.page ? ` · Page ${s.page}` : ""}
                  </strong>
                  <blockquote>{s.quote}</blockquote>
                  {s.kind === "invoice" ? (
                    <a
                      href={`/api/invoices/${invoiceId}/source`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open source PDF <ArrowUpRight size={13} />
                    </a>
                  ) : (
                    s.kind === "document" && (
                      <a
                        href={`/api/documents/${s.document_id}/source`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open reference PDF <ArrowUpRight size={13} />
                      </a>
                    )
                  )}
                </div>
              ))}
            </details>
          )}
          {data.draft_message && (
            <details className="assistant-draft">
              <summary>Prepared follow-up draft</summary>
              <p className="draft-message">{data.draft_message}</p>
              <div className="form-actions">
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(data.draft_message!);
                      setCopied(true);
                      setCopyError("");
                    } catch {
                      setCopyError("Select the draft text to copy it.");
                    }
                  }}
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}{" "}
                  {copied ? "Copied" : "Copy draft"}
                </Button>
                <small>Review before sharing. Nothing has been sent.</small>
              </div>
              {copyError && <p role="status">{copyError}</p>}
            </details>
          )}
        </>
      )}
    </section>
  );
}
