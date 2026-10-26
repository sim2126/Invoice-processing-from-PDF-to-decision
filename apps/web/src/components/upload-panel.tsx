"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, fileUpload, type UploadResult } from "@/lib/api";
import { cx } from "@/lib/format";
import { keys } from "@/lib/queries";
import { IconClose, IconDownload, IconMail, IconUpload } from "./icons";
import { useShell } from "./shell-context";
import { Drawer, Pill } from "./ui";

type Item = {
  id: number;
  file: File;
  state: "ready" | "sending" | "added" | "existing" | "error";
  message?: string;
  invoiceId?: string;
};

let sequence = 0;

export function UploadPanel({ onClose }: { onClose: () => void }) {
  const { session, notify } = useShell();
  const router = useRouter();
  const client = useQueryClient();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const limitMb = Math.round(session.max_bytes / 1048576);
  const inbox = `invoices@${session.company.name.toLowerCase().replace(/[^a-z0-9]/g, "") || "company"}.com`;

  function add(list: FileList | File[]) {
    const next = Array.from(list).map<Item>((file) => {
      const problem = !file.name.toLowerCase().endsWith(".pdf")
        ? "Only PDF files can be checked."
        : file.size === 0
          ? "This file is empty."
          : file.size > session.max_bytes
            ? `Larger than ${limitMb} MB.`
            : undefined;
      sequence += 1;
      return {
        id: sequence,
        file,
        state: problem ? "error" : "ready",
        message: problem,
      };
    });
    setItems((current) => [...current, ...next]);
  }

  function update(id: number, patch: Partial<Item>) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  async function send() {
    setBusy(true);
    let first: string | null = null;
    let failed = 0;
    let sent = 0;
    let existing = 0;
    for (const item of items) {
      if (item.state !== "ready") {
        if (item.invoiceId && !first) first = item.invoiceId;
        continue;
      }
      update(item.id, { state: "sending" });
      try {
        const result = await api<UploadResult>(
          "/invoices",
          fileUpload(session.csrf, item.file),
        );
        if (result.existing) existing += 1;
        else sent += 1;
        first ??= result.id;
        update(item.id, {
          state: result.existing ? "existing" : "added",
          invoiceId: result.id,
        });
      } catch (error) {
        failed += 1;
        update(item.id, {
          state: "error",
          message:
            error instanceof Error ? error.message : "This file couldn’t be added.",
        });
      }
    }
    setBusy(false);
    await client.invalidateQueries({ queryKey: keys.invoices });
    if (first && !failed) {
      onClose();
      router.push(`/invoices/${first}`);
      // The same file twice opens the original run instead of a second invoice.
      notify(
        sent === 0
          ? "Already received · opening the original"
          : existing
            ? `${sent} added · ${existing} already received`
            : sent > 1
              ? `${sent} invoices added · checking now`
              : "Invoice added · checking now",
      );
    }
  }

  const ready = items.filter((i) => i.state === "ready").length;
  const firstAdded = items.find((i) => i.invoiceId)?.invoiceId;

  return (
    <Drawer
      open
      onOpenChange={(open) => !open && onClose()}
      busy={busy}
      title="Add invoices"
      description="Upload PDFs or forward them by email. Each one is checked against your orders and policy."
    >
      <div className="tm-drawer-b">
        <label
          className={cx("tm-drop", over && "is-over")}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            if (!busy) add(event.dataTransfer.files);
          }}
        >
          <IconUpload size={22} />
          <strong style={{ color: "var(--ink)", fontSize: 13.5 }}>
            Drop invoice PDFs or browse
          </strong>
          <span>
            Scans and multi-page files welcome · up to {session.max_pages} pages
            and {limitMb} MB each
          </span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            multiple
            disabled={busy}
            aria-label="Choose invoice PDFs"
            onChange={(event) => {
              if (event.target.files) add(event.target.files);
              event.target.value = "";
            }}
          />
        </label>
        {items.length > 0 && (
          <ul className="tm-files" aria-label="Files to add">
            {items.map((item) => (
              <li key={item.id}>
                <span className="tm-ellipsis tm-mono" style={{ fontSize: 12.5 }}>
                  {item.file.name}
                </span>
                <span>
                  {item.state === "ready" && (
                    <button
                      className="tm-icon-btn"
                      style={{ width: 26, height: 26 }}
                      aria-label={`Remove ${item.file.name}`}
                      onClick={() =>
                        setItems((current) => current.filter((i) => i.id !== item.id))
                      }
                      disabled={busy}
                    >
                      <IconClose size={14} />
                    </button>
                  )}
                  {item.state === "sending" && <Pill tone="is-processing">Adding</Pill>}
                  {item.state === "added" && <Pill tone="is-approved">Added</Pill>}
                  {item.state === "existing" && <Pill tone="is-hold">Already received</Pill>}
                  {item.state === "error" && <Pill tone="is-blocked">Not added</Pill>}
                </span>
                {item.message && (
                  <span
                    className="tm-bad-text"
                    style={{ gridColumn: "1 / -1", fontSize: 12.5 }}
                    role="alert"
                  >
                    {item.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="tm-diff" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <IconMail size={15} />
            Or forward invoices by email
          </span>
          <strong className="tm-mono" style={{ textAlign: "left", fontSize: 13.5 }}>
            {inbox}
          </strong>
          <span style={{ fontSize: 12.5 }}>
            Emailed invoices wait in the Inbox on the overview until you check
            them. Anything that needs a person lands in Needs action.
          </span>
        </div>
        <p className="tm-hint" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          Need test files?
          <a className="tm-link" href="/api/samples/pack" download>
            <IconDownload size={14} />
            Download sample invoices
          </a>
          <span>(ZIP of PDFs, each described in its README)</span>
        </p>
      </div>
      <div className="tm-drawer-f">
        {firstAdded && !busy && (
          <button
            className="tm-btn tm-btn-line"
            onClick={() => {
              onClose();
              router.push(`/invoices/${firstAdded}`);
            }}
          >
            Open the first invoice
          </button>
        )}
        <button className="tm-btn tm-btn-line" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="tm-btn tm-btn-primary"
          onClick={() => void send()}
          disabled={busy || ready === 0}
        >
          {busy
            ? "Adding…"
            : ready > 1
              ? `Check ${ready} invoices`
              : "Check invoice"}
        </button>
      </div>
    </Drawer>
  );
}
