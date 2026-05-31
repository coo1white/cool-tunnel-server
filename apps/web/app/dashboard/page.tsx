// SPDX-License-Identifier: AGPL-3.0-only
//
// Dashboard with Suspense + Skeleton (added in v0.8.0 / Learning #9).
// The three data sections render independently — the page no longer
// blocks on the slowest of the three before showing anything. Each
// section streams in as its data resolves.

import Link from "next/link";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { getStatus, listAudit, listProxyAccounts } from "../../src/api";
import { AdminShell, StatusPill } from "../../src/ui";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  return (
    <AdminShell title="Dashboard" subtitle="Runtime overview">
      <Suspense fallback={<MetricsSkeleton />}>
        <MetricsSection />
      </Suspense>
      <section className="grid" style={{ marginTop: 16 }}>
        <Suspense fallback={<CardSkeleton heading="Services" rows={5} />}>
          <ServicesSection />
        </Suspense>
        <Suspense fallback={<CardSkeleton heading="Recent Proxy Accounts" rows={5} />}>
          <RecentProxySection />
        </Suspense>
        <Suspense fallback={<CardSkeleton heading="Recent Audit" rows={5} />}>
          <RecentAuditSection />
        </Suspense>
      </section>
    </AdminShell>
  );
}

async function MetricsSection() {
  const status = await getStatus();
  return (
    <section className="grid cols-3">
      <div className="card metric">
        Admin users<strong>{status.userCount}</strong>
      </div>
      <div className="card metric">
        Proxy accounts<strong>{status.proxyAccountCount}</strong>
      </div>
      <div className="card metric">
        Active accounts<strong>{status.activeProxyAccountCount}</strong>
      </div>
    </section>
  );
}

function MetricsSkeleton() {
  return (
    <section className="grid cols-3">
      {[0, 1, 2].map((i) => (
        <div className="card metric" key={i}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-2 h-8 w-16" />
        </div>
      ))}
    </section>
  );
}

async function ServicesSection() {
  const status = await getStatus();
  return (
    <div className="card">
      <h2>Services</h2>
      <table>
        <tbody>
          {status.services.map((service) => (
            <tr key={service.name}>
              <td>{service.name}</td>
              <td>
                <StatusPill value={service.status} />
              </td>
              <td className="muted">{service.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function RecentProxySection() {
  const accounts = await listProxyAccounts();
  return (
    <div className="card">
      <h2>Recent Proxy Accounts</h2>
      {accounts.length === 0 ? (
        <div className="empty">No proxy accounts yet.</div>
      ) : (
        <table>
          <tbody>
            {accounts.slice(0, 5).map((account) => (
              <tr key={account.id}>
                <td>
                  <Link href="/users">{account.username}</Link>
                </td>
                <td>
                  <StatusPill value={account.status} />
                </td>
                <td className="muted">{account.subscriptionUrlMasked ?? "No URL"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

async function RecentAuditSection() {
  const audit = await listAudit();
  return (
    <div className="card">
      <h2>Recent Audit</h2>
      {audit.length === 0 ? (
        <div className="empty">No audit events yet.</div>
      ) : (
        <table>
          <tbody>
            {audit.slice(0, 5).map((entry) => (
              <tr key={entry.id}>
                <td>{entry.action}</td>
                <td className="muted">{new Date(entry.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CardSkeleton({ heading, rows }: { heading: string; rows: number }) {
  return (
    <div className="card">
      <h2>{heading}</h2>
      <div className="space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: deterministic placeholder rows
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    </div>
  );
}
