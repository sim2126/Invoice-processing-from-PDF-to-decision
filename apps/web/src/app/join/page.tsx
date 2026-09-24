"use client";
import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Building2, LoaderCircle } from "lucide-react";
import { api, type Session, type InvitePreview } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/common";

export default function Join() {
  const router = useRouter();
  const client = useQueryClient();
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    const value =
      new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
    if (!value) {
      Promise.resolve().then(() =>
        setError(
          new Error("This invitation link is missing its access token."),
        ),
      );
      return;
    }
    api<InvitePreview>("/invitations/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: value }),
    })
      .then((data) => {
        setToken(value);
        setPreview(data);
      })
      .catch(setError);
  }, []);
  const accept = useMutation({
    mutationFn: () =>
      api<Session>("/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name }),
      }),
    onSuccess: (data) => {
      window.history.replaceState(null, "", "/join");
      client.clear();
      client.setQueryData(["session"], data);
      sessionStorage.setItem("ap_started", "1");
      router.replace("/");
    },
  });
  return (
    <main className="join-page">
      <section className="settings-card">
        <span className="brand-symbol">
          <Building2 size={25} />
        </span>
        <h1>{preview ? `Join ${preview.company}` : "Workspace invitation"}</h1>
        <ErrorNotice error={error || accept.error} />
        {!preview && !error && <LoaderCircle className="spin" />}
        {preview && (
          <>
            <p>
              You have been invited as a {preview.role} with {preview.email}.
            </p>
            <form
              className="product-form"
              onSubmit={(e) => {
                e.preventDefault();
                accept.mutate();
              }}
            >
              <label>
                Your full name
                <input
                  required
                  minLength={2}
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              </label>
              <p className="form-hint">
                Accepting switches this browser to the shared workspace. This
                invitation can be used once.
              </p>
              <Button disabled={accept.isPending}>
                {accept.isPending && (
                  <LoaderCircle className="spin" size={16} />
                )}
                Join workspace
              </Button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
