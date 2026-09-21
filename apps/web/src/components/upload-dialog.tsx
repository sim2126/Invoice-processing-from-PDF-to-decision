"use client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { api, type Session, type UploadResult } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileSearch, LoaderCircle, ShieldCheck, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ErrorNotice } from "./common";

export function UploadDialog({
  open,
  setOpen,
  session,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  session: Session;
}) {
  const router = useRouter();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a PDF invoice first.");
      const body = new FormData();
      body.append("file", file);
      return api<UploadResult>("/invoices", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf },
        body,
      });
    },
    onSuccess: async (data) => {
      await client.invalidateQueries({ queryKey: ["queue"] });
      setOpen(false);
      setFile(null);
      router.push(`/invoices/${data.id}`);
    },
  });
  function choose(value?: File) {
    setError(null);
    upload.reset();
    if (!value) return;
    if (
      !value.name.toLowerCase().endsWith(".pdf") ||
      value.size === 0 ||
      value.size > session.max_bytes
    ) {
      setError(
        `Choose a non-empty PDF under ${session.max_bytes / 1048576} MB.`,
      );
      return;
    }
    setFile(value);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!upload.isPending) setOpen(next);
      }}
    >
      <DialogContent
        title="Upload an invoice"
        description={`One invoice, one PDF. Native text or a readable scan, up to ${session.max_pages} pages and ${session.max_bytes / 1048576} MB.`}
      >
        <input
          ref={input}
          className="sr-only"
          id="invoice-file"
          type="file"
          accept="application/pdf"
          aria-label="Choose invoice PDF"
          onChange={(e) => choose(e.target.files?.[0])}
        />
        <button
          className={cn("dropzone", drag && "dragging")}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            choose(e.dataTransfer.files[0]);
          }}
        >
          <span className="upload-symbol">
            <Upload size={24} />
          </span>
          <strong>{file ? file.name : "Drop your invoice here"}</strong>
          <span>
            {file
              ? `${(file.size / 1024).toFixed(0)} KB · Click to choose another file`
              : "or click to browse files"}
          </span>
        </button>
        <div className="privacy-note">
          <ShieldCheck size={16} />
          <span>
            Your source stays private to this demo session. Every decision
            includes an audit record.
          </span>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <ErrorNotice error={upload.error} />
        <div className="dialog-actions">
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={upload.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => upload.mutate()}
            disabled={!file || upload.isPending}
          >
            {upload.isPending ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <FileSearch size={16} />
            )}
            {upload.isPending ? "Submitting invoice…" : "Upload & run checks"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
