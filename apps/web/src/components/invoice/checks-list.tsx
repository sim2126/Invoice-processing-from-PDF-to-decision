"use client";
import { Fragment, useState } from "react";
import type { Assistance, Detail } from "@/lib/api";
import { cx } from "@/lib/format";
import { isFinal, type DisplayStep, type StepKey, type StepSection } from "@/lib/steps";
import { IconChevronRight, IconExternal, StateIcon } from "../icons";

const SECTIONS: StepSection[] = ["Read", "Match", "Check", "Decide"];

export function ChecksList({
  steps,
  detail,
  live,
}: {
  steps: DisplayStep[];
  detail: Detail;
  /** Results are arriving now: ticks draw in as each step lands. */
  live: boolean;
}) {
  const [open, setOpen] = useState<StepKey | null>(null);
  const decision =
    detail.decision && detail.invoice.decision_applicable ? detail.decision : null;
  const assistant = (decision?.assistant ?? {}) as Assistance;
  return (
    <div className="tm-steps">
      {SECTIONS.map((section) => (
        <div key={section} role="group" aria-labelledby={`tm-steps-${section}`}>
          <div className="tm-step-group" id={`tm-steps-${section}`}>
            {section}
          </div>
          <ol>
            {steps
              .filter((s) => s.section === section)
              .map((step) => (
                <StepRow
                  key={step.key}
                  step={step}
                  live={live}
                  open={open === step.key}
                  onToggle={() => setOpen((o) => (o === step.key ? null : step.key))}
                  assistant={step.key === "explain" ? assistant : undefined}
                />
              ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function StepRow({
  step,
  live,
  open,
  onToggle,
  assistant,
}: {
  step: DisplayStep;
  live: boolean;
  open: boolean;
  onToggle: () => void;
  assistant?: Assistance;
}) {
  const final = isFinal(step.display);
  // A step the pipeline itself reports as running can say what it is doing.
  const working = step.display === "running" && step.state === "running";
  const explanation =
    assistant?.status === "ready" && !!assistant.explanation?.trim();
  const expandable =
    final && (step.facts.length > 0 || step.items.length > 0 || explanation);
  const tone =
    step.display === "review"
      ? "tone-review"
      : step.display === "blocked"
        ? "tone-blocked"
        : undefined;
  const className = cx(
    "tm-step",
    step.display === "running" && "is-running",
    step.display === "pending" && "is-pending",
    open && "is-open",
  );
  const panelId = `tm-step-${step.key}`;
  const body = (
    <>
      <span className={`tm-step-ic s-${step.display}`}>
        <StateIcon state={step.display} animate={live} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="tm-step-t">{step.label}</span>
        {(final || working) && step.detail && (
          <span className={cx("tm-step-d", tone)}>{step.detail}</span>
        )}
      </span>
      {expandable ? (
        <IconChevronRight size={14} className="tm-step-chev" />
      ) : (
        <span />
      )}
    </>
  );
  return (
    <li>
      {expandable ? (
        <button
          type="button"
          className={className}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          {body}
        </button>
      ) : (
        <div className={className}>{body}</div>
      )}
      {expandable && (
        <div className="tm-step-x" id={panelId} hidden={!open}>
          {explanation && assistant && <Explanation assistant={assistant} />}
          {step.facts.length > 0 && (
            <dl className="tm-facts">
              {step.facts.map((f) => (
                <Fragment key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          {step.items.length > 0 && (
            <ul className="tm-items" aria-label="Individual checks">
              {step.items.map((item, index) => (
                <li key={`${item.title}-${index}`}>
                  <span
                    className={`tm-step-ic s-${item.state}`}
                    style={{ width: 16, height: 16 }}
                  >
                    <StateIcon state={item.state} size={14} />
                  </span>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.text}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function Explanation({ assistant }: { assistant: Assistance }) {
  const sources = (assistant.sources ?? []).filter(
    (s) => s.kind === "document" || s.kind === "invoice",
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ fontSize: 13, color: "var(--ink-2)", whiteSpace: "pre-line" }}>
        {assistant.explanation}
      </p>
      {assistant.question && (
        <p style={{ fontSize: 12.5 }}>
          <strong style={{ fontWeight: 600 }}>Open question · </strong>
          {assistant.question}
        </p>
      )}
      {sources.length > 0 && (
        <ul className="tm-items" aria-label="Sources">
          {sources.slice(0, 4).map((source, index) => (
            <li key={`${source.id}-${index}`} style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
              <div>
                <strong>
                  {source.kind === "invoice" ? "This invoice" : source.title}
                  {source.page ? ` · page ${source.page}` : ""}
                </strong>
                <span className="tm-quote" style={{ display: "block", marginTop: 4 }}>
                  {source.quote.length > 220
                    ? `${source.quote.slice(0, 217).trimEnd()}…`
                    : source.quote}
                </span>
                {source.kind === "document" && source.document_id && (
                  <a
                    className="tm-link"
                    style={{ marginTop: 4 }}
                    href={`/api/documents/${encodeURIComponent(source.document_id)}/source`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open {source.title}
                    <IconExternal size={13} />
                    <span className="tm-sr"> (opens in a new tab)</span>
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
