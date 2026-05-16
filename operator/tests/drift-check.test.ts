// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/drift-check.test.ts — pure-logic tests for the
// three-way cleartext drift detector.

import { test, expect } from "bun:test";
import {
    classifyRow,
    parseSingBoxUsers,
    parseSubscriptionResponse,
    buildReport,
    renderTable,
    type DriftRow,
} from "../src/util/drift-check";

// ---------- parseSingBoxUsers ----------

test("parseSingBoxUsers extracts username/password tuples from naive inbound", () => {
    const cfg = JSON.stringify({
        inbounds: [
            {
                type: "naive",
                tag: "naive-in",
                users: [
                    { username: "alice", password: "pw-alice" },
                    { username: "bob", password: "pw-bob" },
                ],
            },
        ],
    });
    expect(parseSingBoxUsers(cfg)).toEqual([
        { username: "alice", password: "pw-alice" },
        { username: "bob", password: "pw-bob" },
    ]);
});

test("parseSingBoxUsers ignores non-naive inbounds", () => {
    const cfg = JSON.stringify({
        inbounds: [
            { type: "http", users: [{ username: "alice", password: "pw-alice" }] },
            { type: "naive", users: [{ username: "bob", password: "pw-bob" }] },
        ],
    });
    expect(parseSingBoxUsers(cfg)).toEqual([{ username: "bob", password: "pw-bob" }]);
});

test("parseSingBoxUsers returns [] for credentialless config", () => {
    const cfg = JSON.stringify({ inbounds: [{ type: "naive" }] });
    expect(parseSingBoxUsers(cfg)).toEqual([]);
});

test("parseSingBoxUsers throws on malformed JSON (caller distinguishes broken render)", () => {
    expect(() => parseSingBoxUsers("not json")).toThrow();
});

// ---------- parseSubscriptionResponse ----------

test("parseSubscriptionResponse extracts profiles[]", () => {
    const body = JSON.stringify({
        version: 1,
        server: "naive.example.com",
        profiles: [{ host: "naive.example.com", port: 443, username: "alice", password: "pw" }],
        capabilities: {},
        signature: "deadbeef",
    });
    const r = parseSubscriptionResponse(body);
    expect(r).not.toBeNull();
    expect(r!.version).toBe(1);
    expect(r!.profiles).toEqual([
        { host: "naive.example.com", port: 443, username: "alice", password: "pw" },
    ]);
});

test("parseSubscriptionResponse returns null on cover-site (HTML)", () => {
    expect(parseSubscriptionResponse("<!doctype html><html>...</html>")).toBeNull();
});

test("parseSubscriptionResponse returns null when version field absent", () => {
    expect(parseSubscriptionResponse('{"server":"x","profiles":[]}')).toBeNull();
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

test("classifyRow ok when all three layers agree", () => {
    const r = row({ username: "alice", db: "pw", singbox: "pw", subscription: "pw" });
    expect(classifyRow(r).severity).toBe("ok");
});

test("classifyRow fails on db↔singbox drift (today's exact incident shape)", () => {
    // DB has the rotated value, sing-box never re-rendered.
    const r = row({ username: "alice", db: "new-pw", singbox: "old-pw", subscription: "new-pw" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("db↔singbox");
});

test("classifyRow fails on db↔subscription drift", () => {
    // sing-box re-rendered, panel got rolled back somehow.
    const r = row({ username: "alice", db: "new-pw", singbox: "new-pw", subscription: "old-pw" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("db↔subscription");
});

test("classifyRow fails when sing-box has no user but DB does", () => {
    const r = row({ username: "alice", db: "pw", singbox: null, subscription: "pw" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("render singbox");
});

test("classifyRow warns when subscription returns cover-site (null)", () => {
    const r = row({ username: "alice", db: "pw", singbox: "pw", subscription: null });
    expect(classifyRow(r).severity).toBe("warn");
});

test("classifyRow fails on phantom sing-box user (DB row absent)", () => {
    const r = row({ username: "ghost", db: null, singbox: "pw" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("phantom");
});

// ---------- buildReport / renderTable ----------

test("buildReport ok = false if any finding is fail", () => {
    const r = buildReport([
        row({ username: "alice", db: "pw", singbox: "pw", subscription: "pw" }),
        row({ username: "bob", accountId: 2, db: "x", singbox: "y", subscription: "z" }),
    ]);
    expect(r.ok).toBe(false);
});

test("buildReport ok = true when every row is ok", () => {
    const r = buildReport([
        row({ username: "alice", db: "pw", singbox: "pw", subscription: "pw" }),
        row({ username: "bob", accountId: 2, db: "pw2", singbox: "pw2", subscription: "pw2" }),
    ]);
    expect(r.ok).toBe(true);
});

test("renderTable never leaks cleartext", () => {
    const r = buildReport([
        row({
            username: "alice",
            db: "super-secret-cleartext",
            singbox: "different-secret",
            subscription: "super-secret-cleartext",
        }),
    ]);
    const table = renderTable(r);
    expect(table).not.toContain("super-secret-cleartext");
    expect(table).not.toContain("different-secret");
    expect(table).toContain("DIFF");
});
