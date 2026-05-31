// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared User-detail content rendered by BOTH:
//   - app/users/[id]/page.tsx          — the full-page (deep-link) version
//   - app/users/@modal/(.)[id]/page.tsx — the intercepted modal version
//
// Server component — `await getSession()` and `await getUser()` happen
// here, so the same data fetch runs whether we land on the page directly
// or via soft-nav from /users.

import type { AdminUser } from "@cool-tunnel/shared";
import { ActionForm } from "./action-form";
import { updateUserAction } from "./actions";
import { type ApiSession, has } from "./api";
import { PermissionDenied, StatusPill } from "./ui";
import { UserActions } from "./user-actions";

export interface UserDetailProps {
  readonly user: AdminUser;
  readonly session: ApiSession;
}

export function UserDetail({ user, session }: UserDetailProps) {
  const canDisable = has("users:disable", session);
  const canReset = has("users:reset-password", session);
  const canDelete = has("users:delete", session);

  return (
    <>
      <section className="card">
        <h2>Account</h2>
        <p>
          <StatusPill value={user.status} /> <span className="muted">{user.role}</span>
        </p>
        {has("users:update", session) ? (
          <ActionForm className="form" action={updateUserAction}>
            <input type="hidden" name="id" value={user.id} />
            <div className="grid cols-3">
              <div className="field">
                <label htmlFor={`user-${user.id}-email`}>Email</label>
                <input
                  id={`user-${user.id}-email`}
                  name="email"
                  type="email"
                  defaultValue={user.email}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor={`user-${user.id}-username`}>Username</label>
                <input
                  id={`user-${user.id}-username`}
                  name="username"
                  defaultValue={user.username}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor={`user-${user.id}-name`}>Name</label>
                <input id={`user-${user.id}-name`} name="name" defaultValue={user.name} required />
              </div>
            </div>
            <div className="grid cols-3">
              <div className="field">
                <label htmlFor={`user-${user.id}-role`}>Role</label>
                <select id={`user-${user.id}-role`} name="role" defaultValue={user.role}>
                  <option value="viewer">Viewer</option>
                  <option value="operator">Operator</option>
                  <option value="admin">Admin</option>
                  {session.user.role === "owner" && <option value="owner">Owner</option>}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`user-${user.id}-status`}>Status</label>
                <select id={`user-${user.id}-status`} name="status" defaultValue={user.status}>
                  <option value="active">Active</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>
              <label className="checkbox">
                <input
                  name="mustChangePassword"
                  type="checkbox"
                  defaultChecked={user.mustChangePassword}
                />{" "}
                Require password change
              </label>
            </div>
            {/* Wrap so the button doesn't stretch to the parent grid cell. */}
            <div className="form-actions">
              <button className="btn" type="submit">
                Save user
              </button>
            </div>
          </ActionForm>
        ) : (
          <PermissionDenied />
        )}
      </section>

      {(canDisable || canReset || canDelete) && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Actions</h2>
          <UserActions
            userId={user.id}
            status={user.status}
            canDisable={canDisable}
            canReset={canReset}
            canDelete={canDelete}
          />
        </section>
      )}
    </>
  );
}
