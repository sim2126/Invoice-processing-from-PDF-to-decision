"use client";
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Check,
  Copy,
  Mail,
  Plus,
  ShieldCheck,
} from "lucide-react";
import {
  api,
  mutation,
  stamp,
  type Session,
  type Team,
  type Invite,
} from "@/lib/api";
import { Button } from "../ui/button";
import { ErrorNotice, Policy } from "../common";
import { Pending, PageHeading } from "./shared";

export function Settings({
  session,
  onFresh,
}: {
  session: Session;
  onFresh: () => void;
}) {
  const [tab, setTab] = useState("general");
  return (
    <div className="product-page">
      <PageHeading
        title="Settings"
        description="Your company, your team, and how the desk works."
      />
      <div
        className="product-tabs settings-tabs"
        role="group"
        aria-label="Settings sections"
      >
        {["general", "team", "connections"].map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "general" ? (
        <GeneralSettings session={session} onFresh={onFresh} />
      ) : tab === "team" ? (
        <TeamSettings session={session} />
      ) : (
        <Connections />
      )}
    </div>
  );
}

function GeneralSettings({
  session,
  onFresh,
}: {
  session: Session;
  onFresh: () => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(session.company.name);
  const [address, setAddress] = useState(session.company.address || "");
  const [enabled, setEnabled] = useState(session.company.ai_assistance);
  const save = useMutation({
    mutationFn: () =>
      api<Session>(
        "/company",
        mutation(session.csrf, { name, address, ai_assistance: enabled }),
      ),
    onSuccess: (data) => client.setQueryData(["session"], data),
  });
  const readOnly = session.user.role !== "owner";
  return (
    <>
      <section className="settings-card">
        <h2>Company</h2>
        <p>The company your team reviews invoices for.</p>
        <form
          className="product-form"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="form-columns">
            <label>
              Company name
              <input
                required
                minLength={2}
                maxLength={120}
                disabled={readOnly}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  save.reset();
                }}
              />
            </label>
            <label>
              Currency
              <input value={session.company.currency} disabled />
            </label>
          </div>
          <label>
            Company address
            <textarea
              maxLength={500}
              rows={2}
              disabled={readOnly}
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                save.reset();
              }}
              placeholder="Add your company address"
            />
          </label>
          <div className="setting-switch">
            <div>
              <strong>AI review assistance</strong>
              <p>
                Use invoice facts, purchase orders, and company references to
                explain decisions and prepare follow-ups.
              </p>
            </div>
            <input
              aria-label="AI review assistance"
              type="checkbox"
              role="switch"
              checked={enabled}
              disabled={readOnly}
              onChange={(e) => {
                setEnabled(e.target.checked);
                save.reset();
              }}
            />
          </div>
          <p className="form-hint">
            Supported reference matches can resolve a missing PO automatically.
            Conflicting facts and failed financial checks still need attention.
            Changes apply to future runs.
          </p>
          <div className="form-actions">
            <Button disabled={readOnly || save.isPending}>
              Save company settings
            </Button>
            {save.isSuccess && (
              <span role="status" className="saved-message">
                <Check size={16} /> Settings saved
              </span>
            )}
          </div>
          <ErrorNotice error={save.error} />
          {readOnly && (
            <p className="form-hint">
              Only the workspace owner can edit these settings.
            </p>
          )}
        </form>
      </section>
      <section className="settings-card">
        <div className="record-row">
          <ShieldCheck size={25} />
          <div>
            <h2>Review policy</h2>
            <p>
              Source evidence, duplicates, line items, and purchase-order limits
              are checked on every run.
            </p>
          </div>
          <Policy>
            <Button variant="outline">View policy</Button>
          </Policy>
        </div>
      </section>
      <section className="settings-card">
        <h2>Workspace access</h2>
        <p>
          This evaluation workspace expires {stamp(session.expires_at)}.
          Invitation links share access to this workspace until then.
        </p>
        <div className="form-actions">
          <Button variant="outline" onClick={onFresh}>
            Start a fresh workspace
          </Button>
          <Link className="text-button" href="/documents">
            View sample documents <ArrowUpRight size={15} />
          </Link>
        </div>
      </section>
    </>
  );
}

function TeamSettings({ session }: { session: Session }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["team", session.workspace],
    queryFn: () => api<Team>("/team"),
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("reviewer");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const invite = useMutation({
    mutationFn: () =>
      api<Invite>("/team/invitations", mutation(session.csrf, { email, role })),
    onSuccess: () => {
      setEmail("");
      setCopied(false);
      client.invalidateQueries({ queryKey: ["team"] });
    },
  });
  const remove = useMutation({
    mutationFn: (path: string) =>
      api<void>(path, {
        method: "DELETE",
        headers: { "X-CSRF-Token": session.csrf },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["team"] }),
  });
  const owner = session.user.role === "owner";
  return (
    <>
      <section className="settings-card">
        <h2>Team members</h2>
        <p>
          Owners manage settings. Reviewers resolve invoices. Viewers have
          read-only access.
        </p>
        <ErrorNotice error={query.error} />
        {query.isPending ? (
          <Pending />
        ) : (
          <div className="record-list">
            {query.data?.members.map((m) => (
              <div className="record-row" key={m.id}>
                <span className="person-avatar">
                  {m.name
                    .split(" ")
                    .map((n) => n[0])
                    .slice(0, 2)
                    .join("")}
                </span>
                <div>
                  <strong>
                    {m.name}
                    {m.id === session.user.id && " (you)"}
                  </strong>
                  <small>{m.email}</small>
                </div>
                <span className="role-label">{m.role}</span>
                {owner && m.role !== "owner" && (
                  <Button
                    variant="outline"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(`/team/members/${m.id}`)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      {owner && (
        <section className="settings-card">
          <h2>Invite a teammate</h2>
          <p>
            Create a private, single-use link and share it with your teammate.
          </p>
          <form
            className="invite-form product-form"
            onSubmit={(e) => {
              e.preventDefault();
              invite.mutate();
            }}
          >
            <label>
              Email
              <input
                type="email"
                required
                maxLength={200}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@company.com"
              />
            </label>
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="reviewer">Reviewer</option>
                <option value="viewer">Viewer</option>
              </select>
            </label>
            <Button disabled={invite.isPending}>
              <Plus size={17} />
              Create invite link
            </Button>
          </form>
          <p className="form-hint">
            Anyone holding the link can accept it. No email is sent. The link
            expires with this workspace.
          </p>
          <ErrorNotice error={invite.error} />
          {invite.data && (
            <div className="invite-result">
              <label>
                Invitation for {invite.data.email}
                <input
                  readOnly
                  value={invite.data.url}
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(invite.data!.url);
                    setCopied(true);
                    setCopyError("");
                  } catch {
                    setCopyError("Select and copy the link above.");
                  }
                }}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
                {copied ? "Copied" : "Copy link"}
              </Button>
              {copyError && <p role="status">{copyError}</p>}
            </div>
          )}
          {!!query.data?.invitations.length && (
            <>
              <h3 className="pending-title">Pending invitations</h3>
              <div className="record-list">
                {query.data.invitations.map((i) => (
                  <div className="record-row" key={i.id}>
                    <Mail size={20} />
                    <div>
                      <strong>{i.email}</strong>
                      <small>
                        {i.role} · Expires {stamp(i.expires_at)}
                      </small>
                    </div>
                    <Button
                      variant="outline"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(`/team/invitations/${i.id}`)}
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
          <ErrorNotice error={remove.error} />
        </section>
      )}
    </>
  );
}

function Connections() {
  return (
    <>
      <div className="connection-heading">
        <h2>Inbox</h2>
        <p>Bring invoices and supplier conversations into one place.</p>
      </div>
      <div className="connections-grid">
        {[
          [
            "G",
            "Gmail",
            "Receive invoices and prepare supplier replies.",
            "gmail",
          ],
          [
            "O",
            "Outlook",
            "Keep invoice conversations with your team.",
            "outlook",
          ],
        ].map(([letter, name, text, tone]) => (
          <Connection key={name} {...{ letter, name, text, tone }} />
        ))}
      </div>
      <div className="connection-heading">
        <h2>Accounting</h2>
        <p>Connect supplier records, purchase orders, and approved invoices.</p>
      </div>
      <div className="connections-grid">
        {[
          [
            "qb",
            "QuickBooks Online",
            "Keep supplier and invoice records in sync.",
            "quickbooks",
          ],
          ["x", "Xero", "Bring purchase orders into your review desk.", "xero"],
          ["N", "NetSuite", "Send approved invoices to your ERP.", "netsuite"],
        ].map(([letter, name, text, tone]) => (
          <Connection key={name} {...{ letter, name, text, tone }} />
        ))}
      </div>
    </>
  );
}
function Connection({
  letter,
  name,
  text,
  tone,
}: {
  letter: string;
  name: string;
  text: string;
  tone: string;
}) {
  return (
    <section className="connection-card">
      <div className="connection-top">
        <span aria-hidden="true" className={`connector-mark ${tone}`}>
          {letter}
        </span>
        <span className="coming-soon">Coming soon</span>
      </div>
      <h3>{name}</h3>
      <p>{text}</p>
    </section>
  );
}
