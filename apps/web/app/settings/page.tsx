// SPDX-License-Identifier: AGPL-3.0-only

import { ActionForm } from "../../src/action-form";
import { updateSettingsAction } from "../../src/actions";
import { getSession, getSettings, has } from "../../src/api";
import { AdminShell, PermissionDenied } from "../../src/ui";

export default async function SettingsPage() {
  const session = await getSession();
  const settings = await getSettings();
  return (
    <AdminShell title="Settings" subtitle="Domain and runtime config">
      {!has("settings:update", session) ? (
        <PermissionDenied message="Your role can view settings, but cannot change them." />
      ) : (
        <ActionForm className="card form" action={updateSettingsAction}>
          <div className="grid cols-3">
            <div className="field">
              <label>Proxy domain</label>
              <input name="domain" defaultValue={settings.domain} required />
            </div>
            <div className="field">
              <label>Panel domain</label>
              <input name="panelDomain" defaultValue={settings.panelDomain} required />
            </div>
            <div className="field">
              <label>ACME email</label>
              <input name="acmeEmail" type="email" defaultValue={settings.acmeEmail} required />
            </div>
          </div>
          <div className="field">
            <label>ACME directory</label>
            <input name="acmeDirectory" defaultValue={settings.acmeDirectory} required />
          </div>
          <div className="grid cols-3">
            <label className="checkbox">
              <input
                name="antiTrackingHideIp"
                type="checkbox"
                defaultChecked={settings.antiTrackingHideIp}
              />{" "}
              Hide IP
            </label>
            <label className="checkbox">
              <input
                name="antiTrackingHideVia"
                type="checkbox"
                defaultChecked={settings.antiTrackingHideVia}
              />{" "}
              Hide Via
            </label>
            <label className="checkbox">
              <input
                name="antiTrackingProbeResistance"
                type="checkbox"
                defaultChecked={settings.antiTrackingProbeResistance}
              />{" "}
              Probe resistance
            </label>
          </div>
          <div className="grid cols-3">
            <div className="field">
              <label>DoH resolver</label>
              <input
                name="antiTrackingDohResolver"
                defaultValue={settings.antiTrackingDohResolver}
              />
            </div>
            <div className="field">
              <label>Reality destination</label>
              <input name="realityDestHost" defaultValue={settings.realityDestHost} />
            </div>
            <div className="field">
              <label>Reality short IDs</label>
              <input name="realityShortIds" defaultValue={settings.realityShortIds.join(",")} />
            </div>
          </div>
          <p className="muted">
            Reality public key is configured in the runtime environment and is intentionally not
            editable here.
          </p>
          <button className="btn" type="submit">
            Save settings
          </button>
        </ActionForm>
      )}
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Render State</h2>
        <p className="muted">Last rendered: {settings.lastRenderedAt ?? "Never"}</p>
        <p className="muted">Caddyfile hash: {settings.lastCaddyfileHash ?? "Unavailable"}</p>
      </section>
    </AdminShell>
  );
}
