// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { ActionForm } from "../../src/action-form";
import { changePasswordAction } from "../../src/actions";
import { getSession } from "../../src/api";

export default async function ChangePasswordPage() {
  const session = await getSession();
  if (!session.user.mustChangePassword) redirect("/dashboard");
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <p className="eyebrow">Cool Tunnel Admin</p>
        <h1>Change your password</h1>
        <p>Your account requires a new password before you can continue.</p>
        <ActionForm className="form" action={changePasswordAction}>
          <div className="field">
            <label htmlFor="currentPassword">Current password</label>
            <input
              id="currentPassword"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="newPassword">New password</label>
            <input
              id="newPassword"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="confirmPassword">Confirm new password</label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
          </div>
          <button className="btn" type="submit">
            Update password
          </button>
        </ActionForm>
      </section>
    </main>
  );
}
