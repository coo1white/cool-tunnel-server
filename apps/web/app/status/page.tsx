// SPDX-License-Identifier: AGPL-3.0-only

import { Play, RotateCw } from "lucide-react";
import { ActionForm } from "../../src/action-form";
import { runAction } from "../../src/actions";
import { getStatus } from "../../src/api";
import { AdminShell, StatusPill } from "../../src/ui";

export const metadata = { title: "Status" };

export default async function StatusPage() {
  const status = await getStatus();
  return (
    <AdminShell title="Status" subtitle={`v${status.version}`}>
      <section className="grid cols-3">
        <div className="card metric">
          Owner configured<strong>{status.hasOwner ? "Yes" : "No"}</strong>
        </div>
        <div className="card metric">
          Settings ready<strong>{status.settingsReady ? "Yes" : "No"}</strong>
        </div>
        <div className="card metric">
          Migration<strong>{status.migration.ok ? "Current" : "Action"}</strong>
        </div>
      </section>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Services</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {status.services.map((service) => (
              <tr key={service.name}>
                <td>{service.name}</td>
                <td>
                  <StatusPill value={service.status} />
                </td>
                <td className="muted">{service.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Operations</h2>
        <ActionForm className="toolbar" action={runAction}>
          <button type="submit" className="btn secondary" name="command" value="doctor">
            <Play size={16} /> Doctor
          </button>
          <button type="submit" className="btn secondary" name="command" value="render-singbox">
            <RotateCw size={16} /> Render sing-box
          </button>
          <button type="submit" className="btn secondary" name="command" value="render-caddyfile">
            <RotateCw size={16} /> Render Caddyfile
          </button>
          <button type="submit" className="btn danger" name="command" value="restart">
            Restart
          </button>
        </ActionForm>
      </section>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Migration</h2>
        <p>{status.migration.message}</p>
        <p className="muted">
          Schema {status.migration.currentVersion} / {status.migration.requiredVersion}
        </p>
      </section>
    </AdminShell>
  );
}
