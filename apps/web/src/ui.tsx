// SPDX-License-Identifier: AGPL-3.0-only

import type { Permission } from "@cool-tunnel/shared";
import { LogOut } from "lucide-react";
import { redirect } from "next/navigation";
import { logoutAction } from "./actions";
import { getSession, has } from "./api";
import { type NavIcon, NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";

export { Notice, PermissionDenied, StatusPill } from "./components";

const nav: { href: string; label: string; icon: NavIcon; permission: Permission }[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard", permission: "dashboard:read" },
  { href: "/users", label: "Users", icon: "users", permission: "proxy-accounts:read" },
  { href: "/settings", label: "Settings", icon: "settings", permission: "settings:read" },
  { href: "/status", label: "Status", icon: "status", permission: "status:read" },
  { href: "/audit", label: "Audit", icon: "audit", permission: "audit:read" },
];

export async function AdminShell({
  children,
  title,
  subtitle,
  action,
}: {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  const session = await getSession();
  if (session.user.mustChangePassword) redirect("/change-password");
  const items = nav
    .filter((item) => has(item.permission, session))
    .map(({ href, label, icon }) => ({ href, label, icon }));
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">C</span> Cool Tunnel
        </div>
        <nav className="nav">
          <NavLinks items={items} />
        </nav>
        <div className="nav-spacer" />
        <nav className="nav">
          <form action={logoutAction}>
            <button type="submit">
              <LogOut size={18} /> Logout
            </button>
          </form>
        </nav>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">{subtitle ?? `${session.user.role} access`}</p>
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            {action}
            <ThemeToggle />
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
