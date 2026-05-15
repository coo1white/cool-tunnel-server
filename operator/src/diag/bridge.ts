// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/diag/bridge.ts — format an incident context as a pasteable
// AI prompt + structured JSON. No network calls; operator copies into
// their AI of choice.

import type { IncidentContext } from "./types";

const PROMPT_HEADER =
    "Here is an incident context from ct-operator. The deployment hit a " +
    "failure; you have the structured diagnostic payload below. Respond with:\n" +
    "  1. A diagnosis grounded in specific evidence -- cite the ballast " +
    "check slug, the compose service state, or the journal line you're " +
    "relying on.\n" +
    "  2. A single executable command that will most likely repair the " +
    "failure, OR a short explanation if no single command suffices.\n" +
    "  3. If the payload doesn't contain enough information to diagnose, " +
    "name the specific data you'd need next (e.g. `docker compose logs " +
    "--tail=200 panel`) instead of guessing.\n" +
    "Do not invent file paths or services not present in the payload.";

export function formatBridge(ctx: IncidentContext): string {
    const json = JSON.stringify(ctx, null, 2);
    return `${PROMPT_HEADER}\n\n<ctx schema=${ctx.schema_version}>\n${json}\n</ctx>\n`;
}

export function formatJsonOnly(ctx: IncidentContext): string {
    return JSON.stringify(ctx, null, 2);
}

// Best-effort redaction. The operator controls what hits paste anyway;
// this is a belt for the careless case, not a defence against adversaries.
//
// Order matters: the more specific markers (jwt, Bearer) must run first
// so they don't get swallowed by the generic key=value rule.
export function redact(s: string): string {
    return s
        .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[ip]")
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.\-+/=]+/g, "[jwt]")
        .replace(/Bearer\s+[A-Za-z0-9_.\-+/=]{16,}/g, "Bearer [redacted]")
        .replace(
            /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^'"\s,;]+['"]?/gi,
            "$1=[redacted]",
        );
}

export function redactContext(ctx: IncidentContext): IncidentContext {
    const journalData: Record<string, IncidentContext["journal"]["data"][string]> = {};
    for (const [k, v] of Object.entries(ctx.journal.data)) {
        journalData[k] = { ...v, lines: v.lines.map(redact) };
    }
    return {
        ...ctx,
        journal: { ...ctx.journal, data: journalData },
        proctree: { ...ctx.proctree, data: { lines: ctx.proctree.data.lines.map(redact) } },
        ballast: {
            ...ctx.ballast,
            data: {
                ...ctx.ballast.data,
                checks: ctx.ballast.data.checks.map((c) => ({
                    ...c,
                    detail: c.detail !== undefined ? redact(c.detail) : c.detail,
                })),
            },
        },
        compose: {
            ...ctx.compose,
            data: {
                ...ctx.compose.data,
                services: ctx.compose.data.services.map((s) => ({
                    ...s,
                    // status is the only free-form text field; everything else
                    // is enumerated (service name from compose.yml, state from
                    // a fixed set). Status can include human-readable phrases
                    // like "Exited (137) 30 seconds ago" or rarely an IP/host.
                    status: redact(s.status),
                })),
            },
        },
    };
}
