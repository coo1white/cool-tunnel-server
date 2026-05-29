// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useActionState, useEffect, useState } from "react";
import { Check, Copy, Eye, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import type { ProxyAccount } from "@cool-tunnel/shared";
import { ActionForm } from "./action-form";
import { Notice, StatusPill } from "./components";
import { createProxyAccountAction, proxyCommandAction, revealSubscriptionAction } from "./actions";
import type { ActionState } from "./api";

const PROTOCOL_LABELS: Record<string, string> = { vless_reality: "Reality" };

function protocolLabel(protocols: readonly string[]): string {
  if (!protocols.length) return "—";
  return protocols.map((p) => PROTOCOL_LABELS[p] ?? p).join(", ");
}

// Deterministic YYYY-MM-DD so server and client first paint match (no
// locale-dependent hydration mismatch).
function fmtDate(iso: string | null, fallback: string): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString().slice(0, 10);
}

function RevealSubscription({ id, masked }: { id: string; masked: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function reveal() {
    setBusy(true);
    setErr(null);
    const res = await revealSubscriptionAction(id);
    setBusy(false);
    if (res.ok && res.url) setUrl(res.url);
    else setErr(res.message ?? "Reveal failed.");
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setErr("Clipboard blocked; select and copy manually.");
    }
  }

  return (
    <div className="sub-cell">
      <code className="sub-url" title={url ?? undefined}>{url ?? masked ?? "Unavailable"}</code>
      {url ? (
        <button type="button" className="icon-btn sm" onClick={copy} title="Copy subscription URL">
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      ) : (
        <button type="button" className="icon-btn sm" onClick={reveal} disabled={busy} title="Reveal full URL (audited)">
          <Eye size={15} />
        </button>
      )}
      {err && <span className="sub-err">{err}</span>}
    </div>
  );
}

function CreateModal({ onClose }: { onClose: () => void }) {
  const [state, action] = useActionState<ActionState, FormData>(createProxyAccountAction, { ok: true, message: "" });
  useEffect(() => {
    if (state.ok && state.message) onClose();
  }, [state, onClose]);
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="New proxy account">
        <div className="modal-head">
          <h2>New proxy account</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <form className="form" action={action}>
          <div className="grid cols-3">
            <div className="field"><label>Username</label><input name="username" required autoFocus /></div>
            <div className="field"><label>Label</label><input name="label" /></div>
            <div className="field"><label>Local port</label><input name="clientDefaultLocalPort" type="number" defaultValue="1080" min="1024" max="65535" /></div>
          </div>
          <div className="grid cols-3">
            <div className="field"><label>Expires at</label><input name="expiresAt" type="datetime-local" /></div>
            <label className="checkbox"><input name="enabled" type="checkbox" defaultChecked /> Enabled</label>
            <button className="btn" type="submit"><Plus size={16} /> Create</button>
          </div>
          <Notice state={state} />
        </form>
      </div>
    </div>
  );
}

export function ProxyAccounts({ accounts, canWrite }: { accounts: ProxyAccount[]; canWrite: boolean }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [creating, setCreating] = useState(false);

  const needle = q.trim().toLowerCase();
  const filtered = accounts.filter((a) => {
    const matchesQ = !needle || a.username.toLowerCase().includes(needle) || (a.label ?? "").toLowerCase().includes(needle);
    const matchesStatus = status === "all" || a.status === status;
    return matchesQ && matchesStatus;
  });

  return (
    <section className="card">
      <div className="section-head">
        <h2>Proxy Accounts</h2>
        {canWrite && <button className="btn" type="button" onClick={() => setCreating(true)}><Plus size={16} /> New</button>}
      </div>

      <div className="filters">
        <div className="search">
          <Search size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search username or label" aria-label="Search proxy accounts" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="all">All status</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
          <option value="expired">Expired</option>
        </select>
        <span className="muted count">{filtered.length} of {accounts.length}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">{accounts.length === 0 ? "No proxy accounts yet." : "No accounts match your filter."}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th><th>Status</th><th>Protocol</th><th>Expires</th><th>Last seen</th><th>Subscription</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((account) => (
                <tr key={account.id}>
                  <td>{account.username}<br /><span className="muted">{account.label ?? "No label"}</span></td>
                  <td><StatusPill value={account.status} /></td>
                  <td className="muted">{protocolLabel(account.enabledProtocols)}</td>
                  <td className="muted">{fmtDate(account.expiresAt, "Never")}</td>
                  <td className="muted">{fmtDate(account.lastSeenAt, "—")}</td>
                  <td><RevealSubscription id={account.id} masked={account.subscriptionUrlMasked} /></td>
                  <td>
                    {canWrite && (
                      <div className="toolbar">
                        <ActionForm action={proxyCommandAction}>
                          <input type="hidden" name="id" value={account.id} />
                          <input type="hidden" name="command" value={account.enabled ? "disable" : "enable"} />
                          <button className="btn secondary" type="submit">{account.enabled ? "Disable" : "Enable"}</button>
                        </ActionForm>
                        <ActionForm action={proxyCommandAction}>
                          <input type="hidden" name="id" value={account.id} />
                          <input type="hidden" name="command" value="regenerate-uuid" />
                          <button className="btn secondary" type="submit"><RotateCcw size={16} /> UUID</button>
                        </ActionForm>
                        <ActionForm action={proxyCommandAction}>
                          <input type="hidden" name="id" value={account.id} />
                          <input type="hidden" name="command" value="delete" />
                          <button className="btn danger" type="submit"><Trash2 size={16} /></button>
                        </ActionForm>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateModal onClose={() => setCreating(false)} />}
    </section>
  );
}
