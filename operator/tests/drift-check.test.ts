// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/drift-check.test.ts — pure-logic tests for the
// three-way cleartext drift detector.
//
// v0.3.0+ pulls the proxy-side credentials from the rendered
// /data/config/naive.json (the supervisor's file-watch input)
// instead of v0.2.x's Caddyfile basic_auth lines or v0.1.x's
// sing-box config.json. The legacy parser parseCaddyfileBasicAuth
// is retained for migration windows where the operator still has
// a v0.2.x Caddyfile sitting next to a v0.3.x naive.json; its
// tests stay green.

import { test, expect } from "bun:test";
import {
    classifyRow,
    parseCaddyfileBasicAuth,
    parseNaiveJsonAuth,
    parseSubscriptionResponse,
    buildReport,
    renderTable,
    type DriftRow,
} from "../src/util/drift-check";

// ---------- parseNaiveJsonAuth (v0.3.0+) ----------

const REPRESENTATIVE_NAIVE_JSON = JSON.stringify({
    schema: 1,
    domain: "naive.example.com",
    listen_port: 443,
    user: "alice",
    password: "pw-alice",
    acme_directory_dir: "acme-v02.api.letsencrypt.org-directory",
});

test("parseNaiveJsonAuth extracts (user, password) from the rendered naive.json", () => {
    expect(parseNaiveJsonAuth(REPRESENTATIVE_NAIVE_JSON)).toEqual([
        { username: "alice", password: "pw-alice" },
    ]);
});

test("parseNaiveJsonAuth returns [] on stub renderer output (empty user/password)", () => {
    // Stub form the renderer emits when no active account exists —
    // supervisor refuses to spawn naive until the next render fills
    // these in. Drift checker treats this as "naive carries no
    // credentials" rather than "naive carries empty credentials".
    const stub = JSON.stringify({
        schema: 1,
        domain: "naive.example.com",
        listen_port: 443,
        user: "",
        password: "",
        acme_directory_dir: "acme-v02.api.letsencrypt.org-directory",
    });
    expect(parseNaiveJsonAuth(stub)).toEqual([]);
});

test("parseNaiveJsonAuth returns [] on parse error (malformed JSON, cover-site, etc.)", () => {
    expect(parseNaiveJsonAuth("not json at all")).toEqual([]);
    expect(parseNaiveJsonAuth("")).toEqual([]);
    expect(parseNaiveJsonAuth("[]")).toEqual([]);
    expect(parseNaiveJsonAuth("null")).toEqual([]);
});

test("parseNaiveJsonAuth ignores extra fields (schema-forward-compat)", () => {
    const future = JSON.stringify({
        schema: 1,
        domain: "naive.example.com",
        listen_port: 443,
        user: "alice",
        password: "pw-alice",
        acme_directory_dir: "acme-v02.api.letsencrypt.org-directory",
        // Hypothetical v0.4.x additions:
        rate_limit_per_user: 100,
        cert_renew_strategy: "alpn",
    });
    expect(parseNaiveJsonAuth(future)).toEqual([
        { username: "alice", password: "pw-alice" },
    ]);
});

test("parseNaiveJsonAuth rejects type-mismatched user/password", () => {
    const bad = JSON.stringify({
        user: 42,
        password: "pw",
    });
    expect(parseNaiveJsonAuth(bad)).toEqual([]);
});

// ---------- parseCaddyfileBasicAuth (v0.2.x legacy) ----------

// Kept around so a v0.3.0-upgrade operator with a stale Caddyfile
// next to a fresh naive.json still gets a clean tooling experience.
// New v0.3.x call sites use parseNaiveJsonAuth above.

const REPRESENTATIVE_CADDYFILE = `
{
    email admin@example.com
    auto_https disable_redirects
}

:80 {
    redir https://{host}{uri} 308
}

proxy.example.com {
    route {
        forward_proxy {
            basic_auth alice pw-alice
            basic_auth bob pw-bob
            hide_ip
            hide_via
            probe_resistance abc123.localhost
        }
    }
}

panel.proxy.example.com {
    reverse_proxy panel:9000
}
`;

test("parseCaddyfileBasicAuth extracts every basic_auth in the forward_proxy block", () => {
    expect(parseCaddyfileBasicAuth(REPRESENTATIVE_CADDYFILE)).toEqual([
        { username: "alice", password: "pw-alice" },
        { username: "bob", password: "pw-bob" },
    ]);
});

test("parseCaddyfileBasicAuth never throws on malformed Caddyfile (degrades to [])", () => {
    expect(parseCaddyfileBasicAuth("{{{{ not a caddyfile")).toEqual([]);
});

test("parseCaddyfileBasicAuth handles multiple forward_proxy blocks (defence-in-depth)", () => {
    const fragment = `
a.example.com {
    forward_proxy {
        basic_auth alice pw-alice
    }
}
b.example.com {
    forward_proxy {
        basic_auth bob pw-bob
    }
}
`;
    expect(parseCaddyfileBasicAuth(fragment)).toEqual([
        { username: "alice", password: "pw-alice" },
        { username: "bob", password: "pw-bob" },
    ]);
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
        naive: opts.naive ?? null,
        subscription: opts.subscription ?? null,
    };
}

test("classifyRow ok when all three layers agree", () => {
    const r = row({ username: "alice", db: "pw", naive: "pw", subscription: "pw" });
    expect(classifyRow(r).severity).toBe("ok");
});

test("classifyRow fails on db↔naive drift (the credential-rotation-not-rendered case)", () => {
    const r = row({ username: "alice", db: "new-pw", naive: "old-pw", subscription: "new-pw" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("db↔naive");
});

test("classifyRow fails on db↔subscription drift", () => {
    const r = row({ username: "alice", db: "new-pw", naive: "new-pw", subscription: "old-pw" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("db↔subscription");
});

test("classifyRow fails when naive has no user but DB does", () => {
    const r = row({ username: "alice", db: "pw", naive: null, subscription: "pw" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("render naive");
});

test("classifyRow warns when subscription returns cover-site (null)", () => {
    const r = row({ username: "alice", db: "pw", naive: "pw", subscription: null });
    expect(classifyRow(r).severity).toBe("warn");
});

test("classifyRow fails on phantom naive user (DB row absent)", () => {
    const r = row({ username: "ghost", db: null, naive: "pw" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("phantom");
});

// ---------- buildReport / renderTable ----------

test("buildReport ok = false if any finding is fail", () => {
    const r = buildReport([
        row({ username: "alice", db: "pw", naive: "pw", subscription: "pw" }),
        row({ username: "bob", accountId: 2, db: "x", naive: "y", subscription: "z" }),
    ]);
    expect(r.ok).toBe(false);
});

test("buildReport ok = true when every row is ok", () => {
    const r = buildReport([
        row({ username: "alice", db: "pw", naive: "pw", subscription: "pw" }),
        row({ username: "bob", accountId: 2, db: "pw2", naive: "pw2", subscription: "pw2" }),
    ]);
    expect(r.ok).toBe(true);
});

test("renderTable never leaks cleartext", () => {
    const r = buildReport([
        row({
            username: "alice",
            db: "super-secret-cleartext",
            naive: "different-secret",
            subscription: "super-secret-cleartext",
        }),
    ]);
    const table = renderTable(r);
    expect(table).not.toContain("super-secret-cleartext");
    expect(table).not.toContain("different-secret");
    expect(table).toContain("DIFF");
});
