// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { Activity, ClipboardList, Gauge, Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Icon keys are serializable, so the server shell can filter nav items by
// permission and hand this client component a plain list (component refs
// can't cross the server/client boundary).
const ICONS = {
  dashboard: Gauge,
  users: Users,
  settings: Settings,
  status: Activity,
  audit: ClipboardList,
} as const;

export type NavIcon = keyof typeof ICONS;

export function NavLinks({ items }: { items: { href: string; label: string; icon: NavIcon }[] }) {
  const pathname = usePathname();
  return (
    <>
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={active ? "active" : undefined}
            aria-current={active ? "page" : undefined}
          >
            <Icon size={18} /> {item.label}
          </Link>
        );
      })}
    </>
  );
}
