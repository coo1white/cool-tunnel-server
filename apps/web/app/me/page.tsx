// SPDX-License-Identifier: AGPL-3.0-only
//
// Self-service account page. Added in v0.7.3 alongside the better-auth
// twoFactor plugin (Learning #14) — needed somewhere for the user to
// enable / disable 2FA from. Server component; fetches the session and
// renders profile + a security section. The 2FA enrollment / disable
// flow lives in TwoFactorPanel (a client component so the multi-step
// wizard can hold state).

import { getSession } from "../../src/api";
import { TwoFactorPanel } from "../../src/two-factor-panel";
import { AdminShell, StatusPill } from "../../src/ui";

export default async function MePage() {
  const session = await getSession();
  const u = session.user;
  return (
    <AdminShell title="My Account" subtitle={u.email}>
      <section className="card">
        <h2>Profile</h2>
        <div className="grid cols-3" style={{ marginTop: 12 }}>
          <div className="field">
            <span className="muted">Email</span>
            <strong>{u.email}</strong>
          </div>
          <div className="field">
            <span className="muted">Username</span>
            <strong>{u.username}</strong>
          </div>
          <div className="field">
            <span className="muted">Name</span>
            <strong>{u.name}</strong>
          </div>
          <div className="field">
            <span className="muted">Role</span>
            <strong>{u.role}</strong>
          </div>
          <div className="field">
            <span className="muted">Status</span>
            <StatusPill value={u.status} />
          </div>
          <div className="field">
            <span className="muted">Two-Factor</span>
            <StatusPill value={u.twoFactorEnabled ? "enabled" : "disabled"} />
          </div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Security</h2>
        <p className="muted" style={{ marginBottom: 12 }}>
          Two-factor authentication adds a 6-digit code from your authenticator app on top of your
          password. Keep the backup codes you receive during enrollment — they're the only recovery
          path if you lose your device.
        </p>
        <TwoFactorPanel enabled={u.twoFactorEnabled} />
      </section>
    </AdminShell>
  );
}
