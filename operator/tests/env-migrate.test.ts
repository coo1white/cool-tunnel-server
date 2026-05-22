// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/env-migrate.test.ts — pure .env migration logic.

import { test, expect } from "bun:test";
import {
    backfillPanelDomain,
    relocatePanelDomain,
    fixLegacyAppUrl,
    backfillSingboxDirectDefaults,
    migrateEnv,
    panelDomainDefLine,
    firstPanelDomainRefLine,
} from "../src/util/env-migrate";

// ---------- Phase 1: backfillPanelDomain ----------

test("backfillPanelDomain: inserts PANEL_DOMAIN after DOMAIN when missing", () => {
    const env = `DOMAIN=proxy.example.com
ACME_EMAIL=ops@example.com
APP_URL=https://\${PANEL_DOMAIN}/admin
`;
    const r = backfillPanelDomain(env);
    expect(r.change).not.toBeNull();
    expect(r.content).toContain("PANEL_DOMAIN=panel.proxy.example.com");
    // PANEL_DOMAIN must appear AFTER DOMAIN line, BEFORE APP_URL.
    const lines = r.content.split("\n");
    const domainIdx = lines.findIndex((l) => l.startsWith("DOMAIN="));
    const panelIdx = lines.findIndex((l) => l.startsWith("PANEL_DOMAIN="));
    const appUrlIdx = lines.findIndex((l) => l.startsWith("APP_URL="));
    expect(panelIdx).toBeGreaterThan(domainIdx);
    expect(panelIdx).toBeLessThan(appUrlIdx);
});

test("backfillPanelDomain: idempotent no-op when PANEL_DOMAIN present", () => {
    const env = `DOMAIN=proxy.example.com
PANEL_DOMAIN=admin.example.com
APP_URL=https://\${PANEL_DOMAIN}/admin
`;
    const r = backfillPanelDomain(env);
    expect(r.change).toBeNull();
    expect(r.content).toBe(env);
});

test("backfillPanelDomain: warns when DOMAIN missing too", () => {
    const env = `ACME_EMAIL=ops@example.com
APP_URL=https://\${PANEL_DOMAIN}/admin
`;
    const r = backfillPanelDomain(env);
    expect(r.change).toBeNull();
    expect(r.warning).toContain("DOMAIN missing");
});

test("backfillPanelDomain: strips quotes from DOMAIN value", () => {
    const env = `DOMAIN="proxy.example.com"
`;
    const r = backfillPanelDomain(env);
    expect(r.content).toContain("PANEL_DOMAIN=panel.proxy.example.com");
});

// ---------- Phase 2: relocatePanelDomain ----------

test("relocatePanelDomain: moves PANEL_DOMAIN BEFORE the first \${PANEL_DOMAIN} ref", () => {
    const env = `DOMAIN=proxy.example.com
APP_URL=https://\${PANEL_DOMAIN}/admin
ACME_EMAIL=ops@example.com
PANEL_DOMAIN=admin.example.com
`;
    expect(panelDomainDefLine(env)).toBe(4);
    expect(firstPanelDomainRefLine(env)).toBe(2);
    const r = relocatePanelDomain(env);
    expect(r.change).not.toBeNull();
    const lines = r.content.split("\n");
    const panelIdx = lines.findIndex((l) => l.startsWith("PANEL_DOMAIN="));
    const appUrlIdx = lines.findIndex((l) => l.startsWith("APP_URL="));
    expect(panelIdx).toBeLessThan(appUrlIdx);
});

test("relocatePanelDomain: no-op when PANEL_DOMAIN already precedes its ref", () => {
    const env = `DOMAIN=proxy.example.com
PANEL_DOMAIN=admin.example.com
APP_URL=https://\${PANEL_DOMAIN}/admin
`;
    const r = relocatePanelDomain(env);
    expect(r.change).toBeNull();
    expect(r.content).toBe(env);
});

test("firstPanelDomainRefLine ignores ${PANEL_DOMAIN} inside comments", () => {
    const env = `# example: APP_URL=https://\${PANEL_DOMAIN}/admin
DOMAIN=proxy.example.com
PANEL_DOMAIN=admin.example.com
APP_URL=https://\${PANEL_DOMAIN}/admin
`;
    // First non-comment ref is on line 4 (APP_URL=), not line 1.
    expect(firstPanelDomainRefLine(env)).toBe(4);
});

test("relocatePanelDomain: removes a duplicate appended PANEL_DOMAIN line", () => {
    const env = `DOMAIN=proxy.example.com
APP_URL=https://\${PANEL_DOMAIN}/admin
PANEL_DOMAIN=admin.example.com
`;
    const r = relocatePanelDomain(env);
    expect(r.change).not.toBeNull();
    // Only one PANEL_DOMAIN= line in the output.
    const count = (r.content.match(/^PANEL_DOMAIN=/gm) ?? []).length;
    expect(count).toBe(1);
});

// ---------- Phase 3: fixLegacyAppUrl ----------

test("fixLegacyAppUrl: rewrites APP_URL=https://${DOMAIN}/admin", () => {
    const env = `DOMAIN=proxy.example.com
APP_URL=https://\${DOMAIN}/admin
`;
    const r = fixLegacyAppUrl(env);
    expect(r.change).not.toBeNull();
    expect(r.content).toContain("APP_URL=https://${PANEL_DOMAIN}/admin");
});

test("fixLegacyAppUrl: handles http:// too", () => {
    const env = `APP_URL=http://\${DOMAIN}/admin
`;
    const r = fixLegacyAppUrl(env);
    expect(r.change).not.toBeNull();
    expect(r.content).toContain("APP_URL=http://${PANEL_DOMAIN}/admin");
});

test("fixLegacyAppUrl: no-op when APP_URL already canonical", () => {
    const env = `APP_URL=https://\${PANEL_DOMAIN}/admin
`;
    const r = fixLegacyAppUrl(env);
    expect(r.change).toBeNull();
    expect(r.content).toBe(env);
});

// ---------- Phase 4: backfillSingboxDirectDefaults ----------

test("backfillSingboxDirectDefaults: appends IPv4-only defaults when missing", () => {
    const env = `DOMAIN=proxy.example.com
PANEL_DOMAIN=admin.example.com
APP_URL=https://\${PANEL_DOMAIN}/admin
`;
    const r = backfillSingboxDirectDefaults(env);
    expect(r.change?.phase).toBe("singbox-direct-defaults");
    expect(r.content).toContain("SINGBOX_DIRECT_DOMAIN_STRATEGY=ipv4_only");
    expect(r.content).toContain("SINGBOX_DIRECT_CONNECT_TIMEOUT=2s");
    expect(r.content).toContain("SINGBOX_DIRECT_FALLBACK_DELAY=100ms");
});

test("backfillSingboxDirectDefaults: rewrites legacy prefer_ipv4 to ipv4_only", () => {
    const env = `SINGBOX_DIRECT_DOMAIN_STRATEGY=prefer_ipv4
SINGBOX_DIRECT_CONNECT_TIMEOUT=2s
SINGBOX_DIRECT_FALLBACK_DELAY=100ms
`;
    const r = backfillSingboxDirectDefaults(env);
    expect(r.change?.phase).toBe("singbox-direct-defaults");
    expect(r.content).toContain("SINGBOX_DIRECT_DOMAIN_STRATEGY=ipv4_only");
    expect(r.content).not.toContain("prefer_ipv4");
});

test("backfillSingboxDirectDefaults: no-op when strategy already present", () => {
    const env = `SINGBOX_DIRECT_DOMAIN_STRATEGY=ipv4_only
SINGBOX_DIRECT_CONNECT_TIMEOUT=1500ms
SINGBOX_DIRECT_FALLBACK_DELAY=50ms
`;
    const r = backfillSingboxDirectDefaults(env);
    expect(r.change).toBeNull();
    expect(r.content).toBe(env);
});

test("backfillSingboxDirectDefaults: fills missing timeout keys for existing strategy", () => {
    const env = `SINGBOX_DIRECT_DOMAIN_STRATEGY=ipv4_only
`;
    const r = backfillSingboxDirectDefaults(env);
    expect(r.change?.phase).toBe("singbox-direct-defaults");
    expect(r.content).toContain("SINGBOX_DIRECT_DOMAIN_STRATEGY=ipv4_only");
    expect(r.content).toContain("SINGBOX_DIRECT_CONNECT_TIMEOUT=2s");
    expect(r.content).toContain("SINGBOX_DIRECT_FALLBACK_DELAY=100ms");
});

// ---------- migrateEnv (all phases) ----------

test("migrateEnv: clean canonical .env is a full no-op", () => {
    const env = `DOMAIN=proxy.example.com
PANEL_DOMAIN=admin.example.com
APP_URL=https://\${PANEL_DOMAIN}/admin
SINGBOX_DIRECT_DOMAIN_STRATEGY=prefer_ipv4
SINGBOX_DIRECT_CONNECT_TIMEOUT=2s
SINGBOX_DIRECT_FALLBACK_DELAY=100ms
`;
    const r = migrateEnv(env);
    expect(r.changes.map((c) => c.phase)).toEqual(["singbox-direct-defaults"]);
    expect(r.content).toContain("SINGBOX_DIRECT_DOMAIN_STRATEGY=ipv4_only");
});

test("migrateEnv: pre-v0.0.33 legacy .env triggers all three phases", () => {
    const env = `DOMAIN=proxy.example.com
APP_URL=https://\${DOMAIN}/admin
ACME_EMAIL=ops@example.com
`;
    const r = migrateEnv(env);
    // Phase 1 (backfill) + Phase 3 (app-url-fix) fire; phase 2
    // doesn't because the freshly-inserted PANEL_DOMAIN already
    // precedes its reference. Phase 4 appends the persistent
    // sing-box outbound defaults for old installs.
    const phases = r.changes.map((c) => c.phase);
    expect(phases).toContain("panel-domain-backfill");
    expect(phases).toContain("app-url-fix");
    expect(phases).toContain("singbox-direct-defaults");
    expect(r.content).toContain("PANEL_DOMAIN=panel.proxy.example.com");
    expect(r.content).toContain("APP_URL=https://${PANEL_DOMAIN}/admin");
});

test("migrateEnv: pre-v0.0.68 buggy migration triggers phase 2 only", () => {
    const env = `DOMAIN=proxy.example.com
APP_URL=https://\${PANEL_DOMAIN}/admin
ACME_EMAIL=ops@example.com
PANEL_DOMAIN=admin.example.com
`;
    const r = migrateEnv(env);
    expect(r.changes.map((c) => c.phase)).toEqual(["panel-domain-relocate", "singbox-direct-defaults"]);
});
