import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: number;
  /** When set the icon is announced; otherwise it is decorative. */
  label?: string;
};

function make(d: string, strokeWidth = 1.8) {
  function Icon({ size = 16, label, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
        {...(label
          ? { role: "img", "aria-label": label }
          : { "aria-hidden": true })}
        {...rest}
      >
        <path d={d} />
      </svg>
    );
  }
  return Icon;
}

export const IconOverview = make("M4 4h6v7H4zM14 4h6v4h-6zM14 12h6v8h-6zM4 15h6v5H4z");
export const IconInvoices = make(
  "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
);
export const IconSuppliers = make("M3 21V8l6-4 6 4v13M15 21h6V11l-6-3M7 12h4M7 16h4");
export const IconOrders = make(
  "M9 3h6v3H9zM9 4.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2h-2M9 11h6M9 15h4",
);
export const IconPolicy = make("M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6zM9 12l2 2 4-4");
export const IconFile = make(
  "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6",
);
export const IconChevronRight = make("M9 6l6 6-6 6", 2);
export const IconChevronLeft = make("M15 6l-6 6 6 6", 2);
export const IconSelector = make("M8 9l4-4 4 4M8 15l4 4 4-4", 2);
export const IconArrowRight = make("M5 12h14M13 6l6 6-6 6", 2);
export const IconPlus = make("M12 5v14M5 12h14", 2);
export const IconMinus = make("M5 12h14", 2);
export const IconSearch = make("M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-4-4", 2);
export const IconClose = make("M6 6l12 12M18 6L6 18", 2);
export const IconUpload = make(
  "M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
);
export const IconDownload = make("M12 4v11M7 10l5 5 5-5M5 20h14");
export const IconExternal = make(
  "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
);
export const IconDocSearch = make(
  "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5M14 3v6h6M15 16a3 3 0 1 0 6 0a3 3 0 1 0-6 0M20.2 18.2L22 20",
);
export const IconMail = make("M4 6h16v12H4zM4 7l8 6 8-6");
export const IconCopy = make("M9 9h10v10H9zM5 15V5h10");
export const IconArchive = make("M4 7h16M6 7v12h12V7M9 4h6M10 11h4");
export const IconEye = make(
  "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6",
);
export const IconAlert = make(
  "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7.5v5.5M12 16.5v.01",
  2,
);

export function IconTick({
  size = 16,
  label,
  className,
  animate = true,
  ...rest
}: IconProps & { animate?: boolean }) {
  const classes = [animate ? "tm-tick" : null, className].filter(Boolean).join(" ");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      className={classes || undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...rest}
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

const STATE_PATH: Record<string, { d: string; width: number; label: string }> = {
  review: {
    d: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7.5v5.5M12 16.5v.01",
    width: 2.2,
    label: "Needs review",
  },
  blocked: {
    d: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M6.5 6.5l11 11",
    width: 2.2,
    label: "Blocked",
  },
  hold: {
    d: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M10 9v6M14 9v6",
    width: 2,
    label: "On hold",
  },
  skipped: {
    d: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M8 12h8",
    width: 2,
    label: "Not needed",
  },
  pending: { d: "M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0", width: 2, label: "Waiting" },
  running: { d: "M12 3a9 9 0 1 1-9 9", width: 2.4, label: "Running" },
  info: { d: "M5 6h14M5 11h14M5 16h9", width: 2, label: "Written" },
};

/**
 * Icon for a step or verdict state, announced with its meaning. The tick
 * draws in only when `animate` is set (a result arriving live); otherwise it
 * is static, so a row never shows a blank icon.
 */
export function StateIcon({
  state,
  size = 17,
  announce = true,
  animate = false,
}: {
  state: string;
  size?: number;
  announce?: boolean;
  animate?: boolean;
}) {
  if (state === "passed" || state === "approved")
    return (
      <IconTick size={size} label={announce ? "Passed" : undefined} animate={animate} />
    );
  const spec = STATE_PATH[state] ?? STATE_PATH.pending;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={spec.width}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      className={state === "running" ? "tm-spinner" : undefined}
      {...(announce
        ? { role: "img", "aria-label": spec.label }
        : { "aria-hidden": true })}
    >
      <path d={spec.d} />
    </svg>
  );
}

/** Page + folded corner + tick. The fold is the only accent in the mark. */
export function Logo({ size = 28, animated = true }: { size?: number; animated?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path
        d="M8 2H21L30 11V24A6 6 0 0 1 24 30H8A6 6 0 0 1 2 24V8A6 6 0 0 1 8 2Z"
        fill="#14151F"
      />
      <path
        className={animated ? "tm-logo-fold" : undefined}
        d="M21 2V8A3 3 0 0 0 24 11H30Z"
        fill="#5B4CF0"
      />
      <path
        className={animated ? "tm-logo-tick" : undefined}
        d="M9 17.5L13.5 22L22.5 13"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={3.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
