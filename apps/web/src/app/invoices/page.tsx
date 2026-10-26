import type { Metadata } from "next";
import { InvoiceList } from "@/components/invoice-list";

export const metadata: Metadata = { title: "Invoices" };

export default function Page() {
  return <InvoiceList />;
}
