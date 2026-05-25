// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { AdminShell, StatusPill } from "../../src/ui";
import { getStatus, listAudit, listProxyAccounts } from "../../src/api";

export default async function DashboardPage() {
  const [status, accounts, audit] = await Promise.all([getStatus(), listProxyAccounts(), listAudit()]);
  return (
    <AdminShell title="Dashboard" subtitle="Runtime overview">
      <section className="grid cols-3">
        <div className="card metric">Admin users<strong>{status.userCount}</strong></div>
        <div className="card metric">Proxy accounts<strong>{status.proxyAccountCount}</strong></div>
        <div className="card metric">Active accounts<strong>{status.activeProxyAccountCount}</strong></div>
      </section>
      <section className="grid" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Services</h2>
          <table>
            <tbody>
              {status.services.map((service) => (
                <tr key={service.name}>
                  <td>{service.name}</td>
                  <td><StatusPill value={service.status} /></td>
                  <td className="muted">{service.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2>Recent Proxy Accounts</h2>
          {accounts.length === 0 ? <div className="empty">No proxy accounts yet.</div> : (
            <table>
              <tbody>
                {accounts.slice(0, 5).map((account) => (
                  <tr key={account.id}>
                    <td><Link href="/users">{account.username}</Link></td>
                    <td><StatusPill value={account.status} /></td>
                    <td className="muted">{account.subscriptionUrlMasked ?? "No URL"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h2>Recent Audit</h2>
          {audit.length === 0 ? <div className="empty">No audit events yet.</div> : (
            <table>
              <tbody>
                {audit.slice(0, 5).map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.action}</td>
                    <td className="muted">{new Date(entry.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </AdminShell>
  );
}
