// SPDX-License-Identifier: AGPL-3.0-only
//
// Client wrapper used by the intercepting route at
// app/users/@modal/(.)[id]/page.tsx. The intercepted route is a server
// component (so the user data is fetched on the server, same as the
// full page), but Dialog open-state + close-via-router-back must run
// on the client.
//
// Closing the modal calls `router.back()` so the URL pops back from
// /users/<id> to /users. The Dialog itself accepts ANY child content —
// the server passes the rendered <UserDetail> JSX through.

"use client";

import { useRouter } from "next/navigation";
import type * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface UserDetailModalProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: React.ReactNode;
}

export function UserDetailModal({ title, subtitle, children }: UserDetailModalProps) {
  const router = useRouter();

  function handleOpenChange(open: boolean) {
    if (!open) router.back();
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
