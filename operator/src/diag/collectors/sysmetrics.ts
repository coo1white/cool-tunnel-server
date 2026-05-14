// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/diag/collectors/sysmetrics.ts — CPU/mem/disk via /proc + df.
// No external deps. macOS dev fallbacks for paths that don't exist there.

import type { SysMetrics } from "../types";
import { $, capture } from "../../util/sh";

async function readLoadavg(): Promise<{ load_1m: number; load_5m: number; load_15m: number }> {
    try {
        const text = await Bun.file("/proc/loadavg").text();
        const parts = text.trim().split(/\s+/);
        return {
            load_1m: Number(parts[0] ?? 0),
            load_5m: Number(parts[1] ?? 0),
            load_15m: Number(parts[2] ?? 0),
        };
    } catch {
        const r = await capture($`uptime`);
        const m = r.stdout.match(/load averages?:\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
        return {
            load_1m: Number(m?.[1] ?? 0),
            load_5m: Number(m?.[2] ?? 0),
            load_15m: Number(m?.[3] ?? 0),
        };
    }
}

async function readMeminfo(): Promise<{ total_kb: number; available_kb: number; used_pct: number }> {
    try {
        const text = await Bun.file("/proc/meminfo").text();
        const get = (key: string): number => {
            const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
            return m && m[1] ? Number(m[1]) : 0;
        };
        const total = get("MemTotal");
        const avail = get("MemAvailable");
        return {
            total_kb: total,
            available_kb: avail,
            used_pct: total > 0 ? Math.round(((total - avail) / total) * 100) : 0,
        };
    } catch {
        // macOS dev fallback: vm_stat
        const r = await capture($`vm_stat`);
        if (!r.ok) return { total_kb: 0, available_kb: 0, used_pct: 0 };
        const pageSizeMatch = r.stdout.match(/page size of (\d+) bytes/);
        const pageSize = pageSizeMatch && pageSizeMatch[1] ? Number(pageSizeMatch[1]) : 4096;
        const get = (k: string): number => {
            const m = r.stdout.match(new RegExp(`${k}:\\s+(\\d+)`));
            return m && m[1] ? Number(m[1]) : 0;
        };
        const free = get("Pages free");
        const active = get("Pages active");
        const inactive = get("Pages inactive");
        const wired = get("Pages wired down");
        const totalPages = free + active + inactive + wired;
        const total_kb = Math.round((totalPages * pageSize) / 1024);
        const avail_kb = Math.round(((free + inactive) * pageSize) / 1024);
        return {
            total_kb,
            available_kb: avail_kb,
            used_pct: total_kb > 0 ? Math.round(((total_kb - avail_kb) / total_kb) * 100) : 0,
        };
    }
}

async function readDiskUsage(): Promise<Array<{ mount: string; used_pct: number; avail_kb: number }>> {
    const r = await capture($`df -P -k`);
    if (!r.ok) return [];
    const lines = r.stdout.trim().split("\n").slice(1);
    const out: Array<{ mount: string; used_pct: number; avail_kb: number }> = [];
    for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 6) continue;
        const used = (parts[4] ?? "0").replace("%", "");
        out.push({
            mount: parts[5] ?? "?",
            used_pct: Number(used) || 0,
            avail_kb: Number(parts[3] ?? 0),
        });
    }
    return out;
}

async function readCores(): Promise<number> {
    const r = await capture($`getconf _NPROCESSORS_ONLN`);
    return r.ok ? Number(r.stdout.trim()) || 1 : 1;
}

export async function collectSysMetrics(): Promise<SysMetrics> {
    const [load, mem, disk, cores] = await Promise.all([
        readLoadavg(),
        readMeminfo(),
        readDiskUsage(),
        readCores(),
    ]);
    return {
        cpu: { ...load, cores },
        memory: mem,
        disk,
    };
}
