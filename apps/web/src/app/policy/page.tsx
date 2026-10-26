import type { Metadata } from "next";
import { Policy } from "@/components/policy";

export const metadata: Metadata = { title: "Policy" };

export default function Page() {
  return <Policy />;
}
