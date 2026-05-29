// SPDX-License-Identifier: AGPL-3.0-only

import { AdminShell, PermissionDenied, StatusPill } from "../../../src/ui";
import { ActionForm } from "../../../src/action-form";
import { getSession, getUser, has } from "../../../src/api";
import { updateUserAction, userCommandAction } from "../../../src/actions";

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, session] = await Promise.all([params, getSession()]);
  if (!has("users:read", session)) {
    return <AdminShell title="User"><PermissionDenied /></AdminShell>;
  }
  const user = await getUser(id);
  return (
    <AdminShell title={user.name} subtitle={user.email}>
      <section className="card">
        <h2>Account</h2>
        <p><StatusPill value={user.status} /> <span className="muted">{user.role}</span></p>
        {has("users:update", session) ? (
          <ActionForm className="form" action={updateUserAction}>
            <input type="hidden" name="id" value={user.id} />
            <div className="grid cols-3">
              <div className="field"><label>Email</label><input name="email" type="email" defaultValue={user.email} required /></div>
              <div className="field"><label>Username</label><input name="username" defaultValue={user.username} required /></div>
              <div className="field"><label>Name</label><input name="name" defaultValue={user.name} required /></div>
            </div>
            <div className="grid cols-3">
              <div className="field">
                <label>Role</label>
                <select name="role" defaultValue={user.role}>
                  <option value="viewer">Viewer</option>
                  <option value="operator">Operator</option>
                  <option value="admin">Admin</option>
                  {session.user.role === "owner" && <option value="owner">Owner</option>}
                </select>
              </div>
              <div className="field">
                <label>Status</label>
                <select name="status" defaultValue={user.status}>
                  <option value="active">Active</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>
              <label className="checkbox"><input name="mustChangePassword" type="checkbox" defaultChecked={user.mustChangePassword} /> Require password change</label>
            </div>
            <button className="btn" type="submit">Save user</button>
          </ActionForm>
        ) : <PermissionDenied />}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Actions</h2>
        {/* One form per action, command as a hidden input. Multiple submit
            buttons in a single useActionState form drop the clicked button's
            name/value, so `command` arrived empty and the request 404'd. */}
        <div className="toolbar">
          {has("users:disable", session) && (
            <ActionForm action={userCommandAction}>
              <input type="hidden" name="id" value={user.id} />
              <input type="hidden" name="command" value={user.status === "active" ? "disable" : "enable"} />
              <button className="btn secondary" type="submit">{user.status === "active" ? "Disable" : "Enable"}</button>
            </ActionForm>
          )}
          {has("users:reset-password", session) && (
            <ActionForm action={userCommandAction}>
              <input type="hidden" name="id" value={user.id} />
              <input type="hidden" name="command" value="reset-password" />
              <input name="password" type="password" minLength={12} placeholder="New temporary password" />
              <button className="btn secondary" type="submit">Reset password</button>
            </ActionForm>
          )}
          {has("users:delete", session) && (
            <ActionForm action={userCommandAction}>
              <input type="hidden" name="id" value={user.id} />
              <input type="hidden" name="command" value="delete" />
              <button className="btn danger" type="submit">Delete</button>
            </ActionForm>
          )}
        </div>
      </section>
    </AdminShell>
  );
}
