"use client";
import { createContext, useContext } from "react";
import type { Session } from "@/lib/api";

export type Shell = {
  session: Session;
  notify: (text: string) => void;
  openUpload: () => void;
};

export const ShellContext = createContext<Shell | null>(null);

/** Session, toast and upload panel access for pages inside the app shell. */
export function useShell() {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside a ready AppShell");
  return value;
}
