import type { Metadata } from "next";
import { PurchaseOrders } from "@/components/purchase-orders";

export const metadata: Metadata = { title: "Purchase orders" };

export default function Page() {
  return <PurchaseOrders />;
}
