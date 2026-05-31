// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { getSession } from "../../src/api";
import { ChangePasswordForm } from "../../src/change-password-form";

export const metadata = { title: "Change Password" };

export default async function ChangePasswordPage() {
  const session = await getSession();
  if (!session.user.mustChangePassword) redirect("/dashboard");
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <p className="eyebrow">Cool Tunnel Admin</p>
        <h1>Change your password</h1>
        <p>Your account requires a new password before you can continue.</p>
        <ChangePasswordForm />
      </section>
    </main>
  );
}
