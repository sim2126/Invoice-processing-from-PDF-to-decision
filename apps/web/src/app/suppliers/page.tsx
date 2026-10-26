import type { Metadata } from "next";
import { Suppliers } from "@/components/suppliers";

export const metadata: Metadata = { title: "Suppliers" };

export default function Page() {
  return <Suppliers />;
}
