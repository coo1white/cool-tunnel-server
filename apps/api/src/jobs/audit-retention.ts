// SPDX-License-Identifier: AGPL-3.0-only
//
// Audit-log retention job (v0.8.1, Learning #15). Deletes audit_log
// rows older than `retentionDays`. Runs nightly at 03:00 UTC via
// BullMQ's repeatable schedule (configured in ./queue.ts).
//
// Why this is the v0.8.1 demo job: audit_log grows unboundedly today
// (the table is append-only with no cleanup). This was a real gap;
// BullMQ's scheduled-job pattern fits exactly.
//
// The SQL lives in AdminStore.pruneAuditLogOlderThan() — keeping the
// data layer audited even though Prisma is now available, because
// "delete from audit table" is a security-relevant operation.

import type { AdminStore } from "@cool-tunnel/db";

export interface AuditRetentionResult {
  readonly cutoffIso: string;
  readonly deleted: number;
}

export function runAuditRetention(store: AdminStore, retentionDays: number): AuditRetentionResult {
  if (retentionDays <= 0) {
    // Disabled — caller (queue dispatcher) should have skipped, but
    // we double-check here so a misconfigured ad-hoc call doesn't
    // accidentally delete everything.
    return { cutoffIso: new Date(0).toISOString(), deleted: 0 };
  }
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();
  const deleted = store.pruneAuditLogOlderThan(cutoffIso);
  // Self-audit: record that the retention job ran (so investigators
  // can see WHO ran the cleanup and WHEN, even when looking at the
  // log days later when the deleted rows would otherwise be invisible).
  store.audit(null, "job.audit_retention", "audit_log", null, {
    cutoffIso,
    retentionDays,
    deleted,
  });
  return { cutoffIso, deleted };
}
