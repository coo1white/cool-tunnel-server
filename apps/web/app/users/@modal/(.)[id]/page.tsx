// SPDX-License-Identifier: AGPL-3.0-only
//
// Intercepting route — captures soft-navigation to /users/<id> when the
// user came from /users (or any sibling segment) and renders the user
// detail INSIDE a Dialog overlay on top of the list, instead of
// replacing the page.
//
// Hard navigation / deep link / page reload to /users/<id> falls
// through to app/users/[id]/page.tsx (the full-page version) — Next.js
// only triggers intercepting routes for soft navigation.
//
// The `(.)` prefix tells Next.js to intercept routes one segment up
// from this directory's location. Since this file lives at
// app/users/@modal/(.)[id]/page.tsx and the @modal slot is "logically"
// at /users level, (.) means "intercept routes at the same segment
// level as my slot" → captures /users/<id>.
//
// See Learning:-06-routes for the full pattern.

import { getSession, getUser, has } from "../../../../src/api";
import { PermissionDenied } from "../../../../src/ui";
import { UserDetail } from "../../../../src/user-detail";
import { UserDetailModal } from "../../../../src/user-detail-modal";

export const metadata = { title: "User" };

export default async function InterceptedUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, session] = await Promise.all([params, getSession()]);
  if (!has("users:read", session)) {
    return (
      <UserDetailModal title="User">
        <PermissionDenied />
      </UserDetailModal>
    );
  }
  const user = await getUser(id);
  return (
    <UserDetailModal title={user.name} subtitle={user.email}>
      <UserDetail user={user} session={session} />
    </UserDetailModal>
  );
}
