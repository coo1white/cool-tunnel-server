// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/diag/types.ts — shared diagnostic payload schema.

export interface CollectorOutput<T> {
    name: string;
    ok: boolean;
    data: T;
    error?: string;
    duration_ms: number;
}

export interface HostInfo {
    kernel: string;
    uptime_seconds: number;
}

export interface JournalSlice {
    unit: string;
    lines: string[];
    truncated: boolean;
}

export interface SysMetrics {
    cpu: {
        load_1m: number;
        load_5m: number;
        load_15m: number;
        cores: number;
    };
    memory: {
        total_kb: number;
        available_kb: number;
        used_pct: number;
    };
    disk: Array<{
        mount: string;
        used_pct: number;
        avail_kb: number;
    }>;
}

export interface ProcTreeSnapshot {
    lines: string[];
}

export type CheckStatus = "pass" | "warn" | "fail";

export interface BallastCheckResult {
    slug: string;
    title: string;
    status: CheckStatus;
    detail?: string;
}

export interface BallastResult {
    overall_ok: boolean;
    checks: BallastCheckResult[];
}

export interface IncidentContext {
    schema_version: 1;
    operator_version: string;
    task: string;
    exit_code: number;
    summary?: string;
    ts: string;
    host: HostInfo;
    ballast: CollectorOutput<BallastResult>;
    journal: CollectorOutput<Record<string, JournalSlice>>;
    metrics: CollectorOutput<SysMetrics>;
    proctree: CollectorOutput<ProcTreeSnapshot>;
}
