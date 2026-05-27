// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity, ClipboardList, Gauge, LogOut, Settings, Users } from "lucide-react";
import type { Permission } from "@cool-tunnel/shared";
import { getSession, has } from "./api";
import { logoutAction } from "./actions";

export { Notice, PermissionDenied, StatusPill } from "./components";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge, permission: "dashboard:read" as Permission },
  { href: "/users", label: "Users", icon: Users, permission: "proxy-accounts:read" as Permission },
  { href: "/settings", label: "Settings", icon: Settings, permission: "settings:read" as Permission },
  { href: "/status", label: "Status", icon: Activity, permission: "status:read" as Permission },
  { href: "/audit", label: "Audit", icon: ClipboardList, permission: "audit:read" as Permission },
];

export async function AdminShell({ children, title, subtitle, action }: {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  const session = await getSession();
  if (session.user.mustChangePassword) redirect("/change-password");
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Cool Tunnel</div>
        <nav className="nav">
          {nav.filter((item) => has(item.permission, session)).map((item) => {
            const Icon = item.icon;
            return <Link href={item.href} key={item.href}><Icon size={18} /> {item.label}</Link>;
          })}
          <form action={logoutAction}>
            <button type="submit"><LogOut size={18} /> Logout</button>
          </form>
        </nav>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">{subtitle ?? `${session.user.role} access`}</p>
            <h1>{title}</h1>
          </div>
          <div>{action}</div>
        </header>
        {children}
      </main>
    </div>
  );
}
