"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Files, LoaderCircle } from "lucide-react";
import { api, type Session, type Scenario, type UploadResult } from "@/lib/api";
import { Button } from "./ui/button";
import { ErrorNotice } from "./common";

export function LoadExamples({ session }: { session: Session }) {
  const client = useQueryClient();
  const router = useRouter();
  const load = useMutation({
    mutationFn: async () => {
      const samples = await api<Scenario[]>("/scenarios");
      // Keep the business-duplicate sample separate until the clean invoice has
      // completed. Repeated loading is idempotent by source-file hash.
      for (const sample of samples.filter((s) => s.id !== "duplicate")) {
        const source = await fetch(`/api/scenarios/${sample.id}/pdf`);
        if (!source.ok)
          throw new Error(
            "Could not load the samples. Try again; saved invoices will not be duplicated.",
          );
        const body = new FormData();
        body.append("file", await source.blob(), sample.file);
        await api<UploadResult>("/invoices", {
          method: "POST",
          headers: { "X-CSRF-Token": session.csrf },
          body,
        });
      }
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["queue"] });
      router.push("/");
    },
  });
  return (
    <div className="load-examples">
      <Button
        variant="outline"
        disabled={load.isPending || session.user.role === "viewer"}
        onClick={() => load.mutate()}
      >
        {load.isPending ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <Files size={16} />
        )}{" "}
        {load.isPending ? "Loading example invoices…" : "Load example invoices"}
      </Button>
      <ErrorNotice error={load.error} />
    </div>
  );
}
