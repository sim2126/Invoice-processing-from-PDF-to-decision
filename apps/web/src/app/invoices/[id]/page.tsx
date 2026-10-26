import type { Metadata } from "next";
import { InvoiceWorkspace } from "@/components/invoice/workspace";

export const metadata: Metadata = { title: "Invoice" };

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Keyed so view state (tab, zoom, highlight) resets between invoices.
  return <InvoiceWorkspace key={id} id={id} />;
}
