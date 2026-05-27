// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { AdminShell, PermissionDenied, StatusPill } from "../../src/ui";
import { ActionForm } from "../../src/action-form";
import { getSession, has, listProxyAccounts, listUsers } from "../../src/api";
import { createProxyAccountAction, proxyCommandAction } from "../../src/actions";

export default async function UsersPage() {
  const session = await getSession();
  const [users, accounts] = await Promise.all([has("users:read", session) ? listUsers() : Promise.resolve([]), listProxyAccounts()]);
  return (
    <AdminShell
      title="Users"
      subtitle="Admin and proxy accounts"
      action={has("users:create", session) ? <Link className="btn" href="/users/new"><Plus size={16} /> Admin</Link> : null}
    >
      {has("users:read", session) ? (
        <section className="card">
          <h2>Admin Users</h2>
          {users.length === 0 ? <div className="empty">No admin users found.</div> : (
            <table>
              <thead><tr><th>User</th><th>Role</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td><Link href={`/users/${user.id}`}>{user.name}<br /><span className="muted">{user.email}</span></Link></td>
                    <td>{user.role}</td>
                    <td><StatusPill value={user.status} /></td>
                    <td><Link className="btn secondary" href={`/users/${user.id}`}>Edit</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : <PermissionDenied message="Your role can view proxy accounts, but not admin users." />}

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Proxy Accounts</h2>
        {has("proxy-accounts:write", session) && (
          <ActionForm className="form" action={createProxyAccountAction}>
            <div className="grid cols-3">
              <div className="field"><label>Username</label><input name="username" required /></div>
              <div className="field"><label>Label</label><input name="label" /></div>
              <div className="field"><label>Local port</label><input name="clientDefaultLocalPort" type="number" defaultValue="1080" min="1024" max="65535" /></div>
            </div>
            <div className="grid cols-3">
              <div className="field"><label>Expires at</label><input name="expiresAt" type="datetime-local" /></div>
              <label className="checkbox"><input name="enabled" type="checkbox" defaultChecked /> Enabled</label>
              <button className="btn" type="submit"><Plus size={16} /> Create proxy account</button>
            </div>
          </ActionForm>
        )}
        {accounts.length === 0 ? <div className="empty">No proxy accounts yet.</div> : (
          <table>
            <thead><tr><th>Account</th><th>Status</th><th>Subscription</th><th>Actions</th></tr></thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>{account.username}<br /><span className="muted">{account.label ?? "No label"}</span></td>
                  <td><StatusPill value={account.status} /></td>
                  <td className="muted">{account.subscriptionUrlMasked ?? "Unavailable"}</td>
                  <td>
                    {has("proxy-accounts:write", session) && (
                      <ActionForm className="toolbar" action={proxyCommandAction}>
                        <input type="hidden" name="id" value={account.id} />
                        <button className="btn secondary" name="command" value={account.enabled ? "disable" : "enable"} type="submit">{account.enabled ? "Disable" : "Enable"}</button>
                        <button className="btn secondary" name="command" value="regenerate-uuid" type="submit"><RotateCcw size={16} /> UUID</button>
                        <button className="btn danger" name="command" value="delete" type="submit"><Trash2 size={16} /></button>
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AdminShell>
  );
}
