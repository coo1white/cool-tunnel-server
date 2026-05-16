// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/drift-check.test.ts — pure-logic tests for the
// three-way cleartext drift detector.
//
// v0.2.0+ pulls the proxy-side credentials from the rendered
// Caddyfile (forward_proxy { basic_auth USER PASS }) instead of
// the v0.1.x sing-box config.json. Tests in this file pin both
// the Caddyfile parser shape AND the drift-classifier behaviour
// against a representative real-world Caddyfile fragment.

import { test, expect } from "bun:test";
import {
    classifyRow,
    parseCaddyfileBasicAuth,
    parseSubscriptionResponse,
    buildReport,
    renderTable,
    type DriftRow,
} from "../src/util/drift-check";

// ---------- parseCaddyfileBasicAuth ----------

// A Caddyfile fragment shaped exactly like the one
// core/ct-server-core/src/caddy/mod.rs::render emits.
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

test("parseCaddyfileBasicAuth ignores basic_auth outside a forward_proxy block", () => {
    const fragment = `
proxy.example.com {
    basic_auth not-forward-proxy pw-stray
    route {
        forward_proxy {
            basic_auth real-user pw-real
        }
    }
}
`;
    // basic_auth outside forward_proxy is uninteresting (and not
    // something our renderer would emit). Only the inner one
    // gets pulled.
    expect(parseCaddyfileBasicAuth(fragment)).toEqual([
        { username: "real-user", password: "pw-real" },
    ]);
});

test("parseCaddyfileBasicAuth returns [] when no forward_proxy block exists", () => {
    const fragment = `
proxy.example.com {
    reverse_proxy backend:80
}
`;
    expect(parseCaddyfileBasicAuth(fragment)).toEqual([]);
});

test("parseCaddyfileBasicAuth never throws on malformed Caddyfile (degrades to [])", () => {
    expect(parseCaddyfileBasicAuth("{{{{ not a caddyfile")).toEqual([]);
});

test("parseCaddyfileBasicAuth ignores comments inside the block", () => {
    const fragment = `
proxy.example.com {
    forward_proxy {
        # basic_auth commented-out pw-commented
        basic_auth alice pw-alice
    }
}
`;
    expect(parseCaddyfileBasicAuth(fragment)).toEqual([
        { username: "alice", password: "pw-alice" },
    ]);
});

test("parseCaddyfileBasicAuth handles multiple forward_proxy blocks (defence-in-depth)", () => {
    // Our renderer emits only one forward_proxy site, but the
    // parser shouldn't choke on a future config that has two.
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
        caddyfile: opts.caddyfile ?? null,
        subscription: opts.subscription ?? null,
    };
}

test("classifyRow ok when all three layers agree", () => {
    const r = row({ username: "alice", db: "pw", caddyfile: "pw", subscription: "pw" });
    expect(classifyRow(r).severity).toBe("ok");
});

test("classifyRow fails on db↔caddyfile drift (today's exact incident shape)", () => {
    // DB has the rotated value, caddyfile never re-rendered.
    const r = row({ username: "alice", db: "new-pw", caddyfile: "old-pw", subscription: "new-pw" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("db↔caddyfile");
});

test("classifyRow fails on db↔subscription drift", () => {
    // caddyfile re-rendered, panel got rolled back somehow.
    const r = row({ username: "alice", db: "new-pw", caddyfile: "new-pw", subscription: "old-pw" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("db↔subscription");
});

test("classifyRow fails when caddyfile has no user but DB does", () => {
    const r = row({ username: "alice", db: "pw", caddyfile: null, subscription: "pw" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("render caddyfile");
});

test("classifyRow warns when subscription returns cover-site (null)", () => {
    const r = row({ username: "alice", db: "pw", caddyfile: "pw", subscription: null });
    expect(classifyRow(r).severity).toBe("warn");
});

test("classifyRow fails on phantom caddyfile user (DB row absent)", () => {
    const r = row({ username: "ghost", db: null, caddyfile: "pw" });
    const f = classifyRow(r);
    expect(f.severity).toBe("fail");
    expect(f.summary).toContain("phantom");
});

// ---------- buildReport / renderTable ----------

test("buildReport ok = false if any finding is fail", () => {
    const r = buildReport([
        row({ username: "alice", db: "pw", caddyfile: "pw", subscription: "pw" }),
        row({ username: "bob", accountId: 2, db: "x", caddyfile: "y", subscription: "z" }),
    ]);
    expect(r.ok).toBe(false);
});

test("buildReport ok = true when every row is ok", () => {
    const r = buildReport([
        row({ username: "alice", db: "pw", caddyfile: "pw", subscription: "pw" }),
        row({ username: "bob", accountId: 2, db: "pw2", caddyfile: "pw2", subscription: "pw2" }),
    ]);
    expect(r.ok).toBe(true);
});

test("renderTable never leaks cleartext", () => {
    const r = buildReport([
        row({
            username: "alice",
            db: "super-secret-cleartext",
            caddyfile: "different-secret",
            subscription: "super-secret-cleartext",
        }),
    ]);
    const table = renderTable(r);
    expect(table).not.toContain("super-secret-cleartext");
    expect(table).not.toContain("different-secret");
    expect(table).toContain("DIFF");
});
