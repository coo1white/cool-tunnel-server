// SPDX-License-Identifier: AGPL-3.0-only
//
// BullMQ queue + worker setup for admin-api scheduled jobs.
//
// Added in v0.8.1 (Learning #15). One real job today: audit-log
// retention (defined in ./audit-retention.ts). The infrastructure is
// shaped to host future jobs cleanly:
//
//   - Each job type has a typed payload (JobMap below)
//   - Producers call enqueueRepeatable() / enqueueNow() with a typed name
//   - The worker dispatches to the right handler by name
//   - Errors are logged but never crash the worker
//
// Why Redis: BullMQ requires it. We deliberately don't fall back to an
// in-memory queue because (a) scheduled jobs MUST survive process
// restarts, and (b) the 6th container is acceptable footprint for the
// real-value gap this closes (audit_log grows unboundedly today). See
// Learning:-15-redis-bullmq for the decision log.

import type { AdminConfig } from "@cool-tunnel/config";
import type { AdminStore } from "@cool-tunnel/db";
import { type Job, Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { runAuditRetention } from "./audit-retention";

// Use the same IORedis instance type bullmq's ConnectionOptions accepts.
// (BullMQ pins its own ioredis; importing the shared `Redis` type from
// our top-level ioredis can mismatch versions and trip TS.)
type RedisConnection = InstanceType<typeof IORedis>;

// ---------- typed job map -------------------------------------------------
// Add new job names + payload shapes here. The handler dispatch in
// makeWorker() switches on `job.name`. TypeScript narrows the payload
// per branch.

export interface JobMap {
  "audit.retention": { retentionDays: number };
}
export type JobName = keyof JobMap;

// ---------- queue + worker lifecycle --------------------------------------

const QUEUE_NAME = "ct-admin-jobs";

export interface JobRuntime {
  readonly queue: Queue;
  readonly worker: Worker;
  readonly connection: RedisConnection;
  close: () => Promise<void>;
}

export interface JobRuntimeOptions {
  readonly config: AdminConfig;
  readonly store: AdminStore;
}

export function createJobRuntime(options: JobRuntimeOptions): JobRuntime {
  // BullMQ requires the underlying connection to be `lazyConnect: false`
  // (the default) AND to support `maxRetriesPerRequest: null` for the
  // blocking commands the worker uses.
  const connection = new IORedis(options.config.redisUrl, {
    maxRetriesPerRequest: null,
  });

  const queue = new Queue(QUEUE_NAME, { connection });

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      switch (job.name as JobName) {
        case "audit.retention": {
          const payload = job.data as JobMap["audit.retention"];
          return runAuditRetention(options.store, payload.retentionDays);
        }
        default:
          throw new Error(`unknown job name: ${job.name}`);
      }
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    console.error(`[jobs] ${job?.name ?? "?"} failed:`, err.message);
  });
  worker.on("error", (err) => {
    // Surfaces lost-connection errors; the underlying ioredis reconnects.
    console.error(`[jobs] worker error:`, err.message);
  });

  return {
    queue,
    worker,
    connection,
    close: async () => {
      await worker.close();
      await queue.close();
      await connection.quit().catch(() => undefined);
    },
  };
}

// ---------- producer helpers ---------------------------------------------

/** Enqueue a job to run immediately. Used for manual triggers + tests. */
export async function enqueueNow<N extends JobName>(
  runtime: JobRuntime,
  name: N,
  payload: JobMap[N],
): Promise<void> {
  await runtime.queue.add(name, payload, { removeOnComplete: 100, removeOnFail: 100 });
}

/** Register a repeatable schedule. Idempotent — calling again with the
 *  same key replaces. */
export async function enqueueRepeatable<N extends JobName>(
  runtime: JobRuntime,
  name: N,
  payload: JobMap[N],
  options: { cron: string; jobId?: string },
): Promise<void> {
  await runtime.queue.add(name, payload, {
    repeat: { pattern: options.cron },
    jobId: options.jobId ?? `repeat:${name}`,
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}

/** Wire the default scheduled jobs based on config. Called once on
 *  server start. */
export async function scheduleDefaultJobs(runtime: JobRuntime, config: AdminConfig): Promise<void> {
  if (config.auditRetentionDays > 0) {
    // 03:00 UTC daily — quiet hour for most ops.
    await enqueueRepeatable(
      runtime,
      "audit.retention",
      { retentionDays: config.auditRetentionDays },
      { cron: "0 3 * * *" },
    );
  }
}
