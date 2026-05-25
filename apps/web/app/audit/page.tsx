// SPDX-License-Identifier: AGPL-3.0-only

import { AdminShell } from "../../src/ui";
import { listAudit } from "../../src/api";

export default async function AuditPage() {
  const audit = await listAudit();
  return (
    <AdminShell title="Audit" subtitle="Important admin actions">
      <section className="card">
        {audit.length === 0 ? <div className="empty">No audit entries yet.</div> : (
          <table>
            <thead><tr><th>Action</th><th>Target</th><th>Detail</th><th>Time</th></tr></thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.action}</td>
                  <td className="muted">{entry.targetType ?? "-"} {entry.targetId ?? ""}</td>
                  <td><pre>{entry.detail ?? "{}"}</pre></td>
                  <td className="muted">{new Date(entry.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AdminShell>
  );
}
