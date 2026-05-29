// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Plus } from "lucide-react";
import { AdminShell, PermissionDenied, StatusPill } from "../../src/ui";
import { getSession, has, listProxyAccounts, listUsers } from "../../src/api";
import { ProxyAccounts } from "../../src/proxy-accounts";

export default async function UsersPage() {
  const session = await getSession();
  const [users, accounts] = await Promise.all([has("users:read", session) ? listUsers() : Promise.resolve([]), listProxyAccounts()]);
  return (
    <AdminShell
      title="Users"
      subtitle="Admin and proxy accounts"
      action={has("users:create", session) ? <Link className="btn" href="/users/new"><Plus size={16} /> Admin</Link> : null}
    >
      {has("users:read", session) ? (
        <section className="card">
          <h2>Admin Users</h2>
          {users.length === 0 ? <div className="empty">No admin users found.</div> : (
            <table>
              <thead><tr><th>User</th><th>Role</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td><Link href={`/users/${user.id}`}>{user.name}<br /><span className="muted">{user.email}</span></Link></td>
                    <td>{user.role}</td>
                    <td><StatusPill value={user.status} /></td>
                    <td><Link className="btn secondary" href={`/users/${user.id}`}>Edit</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : <PermissionDenied message="Your role can view proxy accounts, but not admin users." />}

      <div style={{ marginTop: 16 }}>
        <ProxyAccounts accounts={accounts} canWrite={has("proxy-accounts:write", session)} />
      </div>
    </AdminShell>
  );
}
