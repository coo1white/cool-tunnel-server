// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/drift-check.test.ts — pure-logic tests for the
// three-way credential drift detector.
//
// v0.4.0+ pulls the proxy-side credentials from the rendered
// /data/config/singbox.json (the singbox-core supervise watch
// target). The credential type is a VLESS UUID per account.

import { test, expect } from "bun:test";
import {
    classifyRow,
    parseSingboxJsonUsers,
    parseSubscriptionResponse,
    buildReport,
    renderTable,
    type DriftRow,
} from "../src/util/drift-check";

// ---------- parseSingboxJsonUsers (v0.4.0+) ----------

const REPRESENTATIVE_SINGBOX_JSON = JSON.stringify({
    log: { level: "info", timestamp: true },
    inbounds: [
        {
            type: "vless",
            tag: "vless-in",
            listen: "::",
            listen_port: 443,
            users: [
                { name: "alice", uuid: "550e8400-e29b-41d4-a716-446655440000", flow: "xtls-rprx-vision" },
                { name: "bob", uuid: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", flow: "xtls-rprx-vision" },
            ],
            tls: {
                enabled: true,
                server_name: "www.microsoft.com",
                reality: { enabled: true, handshake: { server: "www.microsoft.com", server_port: 443 }, private_key: "REDACTED", short_id: [""] },
            },
        },
    ],
    outbounds: [{ type: "direct", tag: "direct" }, { type: "block", tag: "block" }],
});

test("parseSingboxJsonUsers extracts every VLESS user (name + uuid)", () => {
    expect(parseSingboxJsonUsers(REPRESENTATIVE_SINGBOX_JSON)).toEqual([
        { username: "alice", uuid: "550e8400-e29b-41d4-a716-446655440000" },
        { username: "bob", uuid: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" },
    ]);
});

test("parseSingboxJsonUsers ignores non-VLESS inbounds", () => {
    const cfg = JSON.stringify({
        inbounds: [
            {
                type: "socks",
                tag: "socks-in",
                listen: "127.0.0.1",
                listen_port: 1080,
                users: [{ username: "x", password: "y" }],
            },
            {
                type: "vless",
                tag: "vless-in",
                listen: "::",
                listen_port: 443,
                users: [{ name: "real-user", uuid: "uuid-here", flow: "xtls-rprx-vision" }],
                tls: { enabled: true, server_name: "x", reality: { enabled: true, handshake: { server: "x", server_port: 443 }, private_key: "x", short_id: [""] } },
            },
        ],
        outbounds: [],
    });
    expect(parseSingboxJsonUsers(cfg)).toEqual([{ username: "real-user", uuid: "uuid-here" }]);
});

test("parseSingboxJsonUsers returns [] on parse error", () => {
    expect(parseSingboxJsonUsers("not json")).toEqual([]);
    expect(parseSingboxJsonUsers("")).toEqual([]);
    expect(parseSingboxJsonUsers("null")).toEqual([]);
    expect(parseSingboxJsonUsers("[]")).toEqual([]);
});

test("parseSingboxJsonUsers skips users with empty name or uuid", () => {
    const cfg = JSON.stringify({
        inbounds: [
            {
                type: "vless",
                users: [
                    { name: "", uuid: "abc" },
                    { name: "alice", uuid: "" },
                    { name: "bob", uuid: "def" },
                ],
            },
        ],
        outbounds: [],
    });
    expect(parseSingboxJsonUsers(cfg)).toEqual([{ username: "bob", uuid: "def" }]);
});

test("parseSingboxJsonUsers handles multiple vless inbounds", () => {
    const cfg = JSON.stringify({
        inbounds: [
            { type: "vless", users: [{ name: "alice", uuid: "uuid-a" }] },
            { type: "vless", users: [{ name: "bob", uuid: "uuid-b" }] },
        ],
        outbounds: [],
    });
    expect(parseSingboxJsonUsers(cfg)).toEqual([
        { username: "alice", uuid: "uuid-a" },
        { username: "bob", uuid: "uuid-b" },
    ]);
});

// ---------- parseSubscriptionResponse ----------

test("parseSubscriptionResponse extracts uuid-shaped profiles[] (v0.4.0+)", () => {
    const body = JSON.stringify({
        version: 1,
        server: "naive.example.com",
        profiles: [
            { host: "naive.example.com", port: 443, username: "alice", uuid: "uuid-here" },
        ],
        capabilities: {},
        signature: "deadbeef",
    });
    const r = parseSubscriptionResponse(body);
    expect(r).not.toBeNull();
    expect(r!.profiles).toEqual([
        { host: "naive.example.com", port: 443, username: "alice", uuid: "uuid-here" },
    ]);
});

test("parseSubscriptionResponse accepts legacy v0.3.x `password` key during transition", () => {
    // Transition window: a server still on v0.3.x emits the old
    // shape; the operator's drift detector accepts it so the
    // pre-v3.0.0 client cut doesn't silently flag "no credentials".
    const body = JSON.stringify({
        version: 1,
        server: "naive.example.com",
        profiles: [
            { host: "naive.example.com", port: 443, username: "alice", password: "legacy" },
        ],
    });
    const r = parseSubscriptionResponse(body);
    expect(r).not.toBeNull();
    expect(r!.profiles).toEqual([
        { host: "naive.example.com", port: 443, username: "alice", uuid: "legacy" },
    ]);
});

test("parseSubscriptionResponse returns null on cover-site HTML", () => {
    expect(parseSubscriptionResponse("<!doctype html><html></html>")).toBeNull();
});

// ---------- classifyRow ----------

function row(opts: Partial<DriftRow> & { username: string; accountId?: number }): DriftRow {
    return {
        accountId: opts.accountId ?? 1,
        username: opts.username,
        db: opts.db ?? null,
        singbox: opts.singbox ?? null,
        subscription: opts.subscription ?? null,
    };
}

test("classifyRow ok when all three layers agree on the UUID", () => {
    const r = row({ username: "alice", db: "uuid-a", singbox: "uuid-a", subscription: "uuid-a" });
    expect(classifyRow(r).severity).toBe("ok");
    expect(classifyRow(r).summary).toContain("VLESS UUID");
});

test("classifyRow fails on db↔singbox drift", () => {
    const r = row({ username: "alice", db: "new", singbox: "old", subscription: "new" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("db↔singbox");
});

test("classifyRow fails on db↔subscription drift", () => {
    const r = row({ username: "alice", db: "new", singbox: "new", subscription: "old" });
    expect(classifyRow(r).summary).toContain("db↔subscription");
});

test("classifyRow fails when singbox has no user but DB does", () => {
    const r = row({ username: "alice", db: "uuid", singbox: null, subscription: "uuid" });
    expect(classifyRow(r).summary).toContain("render singbox");
});

test("classifyRow warns on subscription cover-site", () => {
    const r = row({ username: "alice", db: "uuid", singbox: "uuid", subscription: null });
    expect(classifyRow(r).severity).toBe("warn");
});

test("classifyRow fails on phantom singbox user (DB absent)", () => {
    const r = row({ username: "ghost", db: null, singbox: "uuid" });
    expect(classifyRow(r).severity).toBe("fail");
    expect(classifyRow(r).summary).toContain("phantom");
});

// ---------- buildReport / renderTable ----------

test("buildReport ok=true when every row aligned", () => {
    const r = buildReport([
        row({ username: "alice", db: "x", singbox: "x", subscription: "x" }),
        row({ username: "bob", accountId: 2, db: "y", singbox: "y", subscription: "y" }),
    ]);
    expect(r.ok).toBe(true);
});

test("buildReport ok=false if any row drifts", () => {
    const r = buildReport([
        row({ username: "alice", db: "x", singbox: "x", subscription: "x" }),
        row({ username: "bob", accountId: 2, db: "y", singbox: "Y", subscription: "y" }),
    ]);
    expect(r.ok).toBe(false);
});

test("renderTable never leaks UUIDs into output", () => {
    const r = buildReport([
        row({
            username: "alice",
            db: "super-secret-uuid",
            singbox: "different-uuid",
            subscription: "super-secret-uuid",
        }),
    ]);
    const table = renderTable(r);
    expect(table).not.toContain("super-secret-uuid");
    expect(table).not.toContain("different-uuid");
    expect(table).toContain("DIFF");
});
