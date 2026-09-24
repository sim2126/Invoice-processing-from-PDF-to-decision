"use client";
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, LoaderCircle } from "lucide-react";
import { api, mutation, stamp, type Session } from "@/lib/api";
import { Button } from "../ui/button";
import { ErrorNotice } from "../common";
import { PageHeading } from "./shared";

export function Profile({ session }: { session: Session }) {
  const client = useQueryClient();
  const [name, setName] = useState(session.user.name);
  const [email, setEmail] = useState(session.user.email);
  const save = useMutation({
    mutationFn: () =>
      api<Session>("/profile", mutation(session.csrf, { name, email })),
    onSuccess: (data) => {
      client.setQueryData(["session"], data);
      client.invalidateQueries({ queryKey: ["team"] });
    },
  });
  return (
    <div className="product-page">
      <PageHeading
        title="Your profile"
        description="The person behind every review and decision."
      />
      <section className="settings-card">
        <h2>Your details</h2>
        <p>Your name appears in review history and on uploaded documents.</p>
        <form
          className="product-form"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="form-columns">
            <label>
              Full name
              <input
                required
                minLength={2}
                maxLength={100}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  save.reset();
                }}
              />
            </label>
            <label>
              Email
              <input
                required
                type="email"
                maxLength={200}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  save.reset();
                }}
              />
            </label>
          </div>
          <p className="form-hint">
            This is your workspace contact address. Access is provided through
            this browser session or a private invitation link.
          </p>
          <div className="form-actions">
            <Button
              disabled={
                save.isPending ||
                (name === session.user.name && email === session.user.email)
              }
            >
              {save.isPending && <LoaderCircle className="spin" size={16} />}
              Save changes
            </Button>
            {save.isSuccess && (
              <span role="status" className="saved-message">
                <Check size={16} /> Profile saved
              </span>
            )}
          </div>
          <ErrorNotice error={save.error} />
        </form>
      </section>
      <section className="settings-card">
        <h2>Your workspace</h2>
        <div className="record-row">
          <Building2 size={23} />
          <div>
            <strong>{session.company.name}</strong>
            <small>
              {session.user.role} · Access until {stamp(session.expires_at)}
            </small>
          </div>
          <Link className="button button-outline" href="/settings">
            Company settings
          </Link>
        </div>
      </section>
    </div>
  );
}
