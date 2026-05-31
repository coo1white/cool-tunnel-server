// SPDX-License-Identifier: AGPL-3.0-only
// Renders the real caddy/Caddyfile.tpl through the boundary renderer to lock
// in the CT_LANDING_PAGE conditional: off must drop the landing site + its SNI
// route entirely; on must emit a valid block with the domain substituted and
// no leftover template markers. Reality stays the catch-all in both cases.

import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { renderTemplate } from "../src/core-boundary";

const TEMPLATE_PATH = resolve(import.meta.dir, "../../../caddy/Caddyfile.tpl");

const BINDINGS = {
  Domain: "proxy.example.com",
  PanelDomain: "panel.example.com",
  AcmeEmail: "ops@example.com",
  AcmeDirectory: "https://acme.example/dir",
};

async function readTemplate(): Promise<string> {
  return Bun.file(TEMPLATE_PATH).text();
}

test("landing page OFF: bare-domain site and its SNI route are dropped", async () => {
  const out = renderTemplate(await readTemplate(), BINDINGS, { LandingPage: false });

  // No landing site, no bare-domain SNI route, no domain substituted
  // anywhere (it only ever appears inside the disabled block).
  expect(out).not.toContain("https://proxy.example.com:8444");
  expect(out).not.toContain("@site_sni");
  expect(out).not.toContain("proxy.example.com");

  // Panel + Reality fallthrough remain intact.
  expect(out).toContain("https://panel.example.com:8443");
  expect(out).toContain("proxy ct-singbox:443");

  // No template markers survive rendering.
  expect(out).not.toContain("{{");
});

test("landing page ON: bare-domain site rendered with cert + no leftover markers", async () => {
  const out = renderTemplate(await readTemplate(), BINDINGS, { LandingPage: true });

  // The bare domain gets its own TLS site (its own cert) + the SNI route.
  expect(out).toContain("https://proxy.example.com:8444");
  expect(out).toContain("@site_sni");
  expect(out).toContain("sni proxy.example.com");
  expect(out).toContain("proxy 127.0.0.1:8444");
  expect(out).toContain("respond `<!doctype html>");

  // Reality is still the catch-all, and it must come AFTER both named SNI
  // routes or panel/landing traffic would be swallowed by the proxy.
  const singbox = out.indexOf("proxy ct-singbox:443");
  expect(singbox).toBeGreaterThan(out.indexOf("sni panel.example.com"));
  expect(singbox).toBeGreaterThan(out.indexOf("sni proxy.example.com"));

  // Every binding substituted; no markers survive.
  expect(out).not.toContain("{{");
});
