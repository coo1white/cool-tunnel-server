// SPDX-License-Identifier: AGPL-3.0-only
//
// Full-page user-detail view. Reached by deep link / hard navigation /
// page reload. Soft-navigation from /users is intercepted by
// app/users/@modal/(.)[id]/page.tsx and rendered as a modal overlay
// instead — see Learning:-06-routes for the full pattern.

import { getSession, getUser, has } from "../../../src/api";
import { AdminShell, PermissionDenied } from "../../../src/ui";
import { UserDetail } from "../../../src/user-detail";

export const metadata = { title: "User" };

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, session] = await Promise.all([params, getSession()]);
  if (!has("users:read", session)) {
    return (
      <AdminShell title="User">
        <PermissionDenied />
      </AdminShell>
    );
  }
  const user = await getUser(id);
  return (
    <AdminShell title={user.name} subtitle={user.email}>
      <UserDetail user={user} session={session} />
    </AdminShell>
  );
}
