"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { useRef, type ReactNode } from "react";
import type { InvoiceStatus } from "@/lib/api";
import { cx } from "@/lib/format";
import { STATUS_LABEL, STATUS_PILL } from "@/lib/status";
import { IconAlert, IconClose, StateIcon } from "./icons";

export function StatusPill({
  status,
  className,
}: {
  status: InvoiceStatus;
  className?: string;
}) {
  return (
    <span className={cx("tm-pill", STATUS_PILL[status], className)}>
      <i aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Pill({
  tone = "",
  children,
}: {
  tone?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx("tm-pill", tone)}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

export function ErrorNotice({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  if (!error) return null;
  const message =
    error instanceof Error ? error.message : "Something went wrong. Try again.";
  return (
    <div className="tm-notice" role="alert">
      <IconAlert size={16} />
      <span style={{ flex: 1 }}>{message}</span>
      {onRetry && (
        <button className="tm-link" type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="tm-empty" role="status">
      <span style={{ color: "var(--accent)" }}>
        <StateIcon state="running" size={20} announce={false} />
      </span>
      <span>{label}</span>
    </div>
  );
}

/** Remembers the opener and returns focus to it (or to main) on close. */
function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      opener.current = document.activeElement as HTMLElement | null;
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      const target = opener.current?.isConnected
        ? opener.current
        : document.getElementById("main");
      target?.focus();
    },
  };
}

/** Right-side panel: focus is trapped inside and Escape closes it. */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  busy = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  busy?: boolean;
  children: ReactNode;
}) {
  const focus = useReturnFocus();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy || next) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="tm-scrim" />
        <Dialog.Content
          className="tm-drawer"
          {...focus}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className="tm-drawer-h">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description>{description}</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              className="tm-icon-btn"
              aria-label="Close"
              disabled={busy}
            >
              <IconClose size={16} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Small centred confirmation dialog. */
export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const focus = useReturnFocus();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="tm-scrim" />
        <Dialog.Content className="tm-dialog" {...focus}>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
