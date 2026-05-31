// SPDX-License-Identifier: AGPL-3.0-only
//
// /me/sessions — first Prisma-backed page in the project (v0.8.0,
// Learning #7+#9). Lists the current user's non-expired sessions.
// The session that opened this page is marked.
//
// Data flow:
//   page (server component, Next.js)
//   → listMySessions() helper (apps/web/src/api.ts)
//   → GET /api/me/sessions on admin-api
//   → admin-api uses Prisma (packages/db/src/prisma.ts) to query the
//     better-auth `session` table filtered by current userId
//
// Why Prisma here and not AdminStore:
//   - Read-only, low blast radius (user only sees own rows)
//   - Demonstrates the type-safe query ergonomics — Prisma's select
//     gives us a typed projection for free
//   - AdminStore stays focused on the audited write paths

import { listMySessions } from "../../../src/api";
import { AdminShell } from "../../../src/ui";

export const metadata = { title: "My Sessions" };

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function summarizeUserAgent(ua: string | null): string {
  if (!ua) return "—";
  // Just the leading product token: "Mozilla/5.0 (Macintosh...) ..."
  // becomes "Mozilla/5.0". Good enough at a glance; full UA in title attr.
  const head = ua.split(" ").slice(0, 1).join(" ");
  return head || ua.slice(0, 32);
}

export default async function MySessionsPage() {
  const sessions = await listMySessions();
  return (
    <AdminShell title="My Sessions" subtitle="Active sign-ins on this account">
      <section className="card">
        <h2>Active sessions ({sessions.length})</h2>
        <p className="muted" style={{ marginBottom: 12 }}>
          Each row is a non-expired session cookie issued to your account. The session you're using
          right now is highlighted.
        </p>
        {sessions.length === 0 ? (
          <p className="muted">No active sessions found.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Expires</th>
                <th>IP</th>
                <th>User agent</th>
                <th>Current</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{formatDate(s.createdAt)}</td>
                  <td>{formatDate(s.expiresAt)}</td>
                  <td className="muted">{s.ipAddress ?? "—"}</td>
                  <td className="muted" title={s.userAgent ?? undefined}>
                    {summarizeUserAgent(s.userAgent)}
                  </td>
                  <td>{s.current ? "✓" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AdminShell>
  );
}
