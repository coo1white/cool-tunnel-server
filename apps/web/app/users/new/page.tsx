// SPDX-License-Identifier: AGPL-3.0-only

import { ActionForm } from "../../../src/action-form";
import { createUserAction } from "../../../src/actions";
import { getSession, has } from "../../../src/api";
import { AdminShell, PermissionDenied } from "../../../src/ui";

export const metadata = { title: "New User" };

export default async function NewUserPage() {
  const session = await getSession();
  return (
    <AdminShell title="New Admin User" subtitle="Create a console account">
      {!has("users:create", session) ? (
        <PermissionDenied />
      ) : (
        <ActionForm className="card form" action={createUserAction}>
          <div className="grid cols-3">
            <div className="field">
              <label>Email</label>
              <input name="email" type="email" required />
            </div>
            <div className="field">
              <label>Username</label>
              <input name="username" required />
            </div>
            <div className="field">
              <label>Name</label>
              <input name="name" required />
            </div>
          </div>
          <div className="grid cols-3">
            <div className="field">
              <label>Role</label>
              <select name="role" defaultValue="viewer">
                <option value="viewer">Viewer</option>
                <option value="operator">Operator</option>
                <option value="admin">Admin</option>
                {session.user.role === "owner" && <option value="owner">Owner</option>}
              </select>
            </div>
            <div className="field">
              <label>Temporary password</label>
              <input name="password" type="password" minLength={12} required />
            </div>
            <label className="checkbox">
              <input name="mustChangePassword" type="checkbox" defaultChecked /> Require password
              change
            </label>
          </div>
          <button className="btn" type="submit">
            Create user
          </button>
        </ActionForm>
      )}
    </AdminShell>
  );
}
