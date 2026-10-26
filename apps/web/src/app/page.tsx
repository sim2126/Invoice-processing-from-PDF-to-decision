import type { Metadata } from "next";
import { Overview } from "@/components/overview";

// The layout's title template only applies to child segments, not to "/".
export const metadata: Metadata = { title: { absolute: "Overview · Tickmark" } };

export default function Page() {
  return <Overview />;
}
