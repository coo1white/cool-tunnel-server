# Disclaimer

COOL TUNNEL SERVER is the **server-side** companion to the
[Cool Tunnel](https://github.com/coo1white/cool-tunnel) macOS client.
It bundles a sing-box VLESS+Reality server runtime with a minimal
Bun/Hono/Better Auth admin panel for owner bootstrap, account
management, diagnostics, service actions, and config rendering.

It is provided **as-is**, for educational and research purposes only.

## Intended use

This software is intended for legitimate uses such as:

- Operating a personal proxy on infrastructure **you own** or are
  **explicitly authorised** to use.
- Learning how sing-box VLESS+Reality, Caddy's SNI routing, and a
  local Rust control-plane daemon interact in a small VPS deployment.
- Performing security research, auditing, and academic study of
  HTTPS-disguised proxy protocols.

This software is **not** intended to facilitate any activity that would
violate applicable law in the jurisdiction where the operator deploys
it, nor in the jurisdiction where any user connects from.

## Operator responsibility

By installing, configuring, or running COOL TUNNEL SERVER you acknowledge
and agree that:

1. **You are the operator**, and compliance with local law is solely
   your responsibility. The authors neither endorse nor encourage any
   illegal activity, including but not limited to unauthorised
   circumvention of network restrictions imposed by law, an employer,
   a school, or any service whose terms of use you have accepted.
2. **You will provision your own infrastructure.** This software ships
   no preconfigured server, no embedded credentials, no directory of
   public servers, and contacts no remote service except the ACME
   directory (Let's Encrypt by default) you point it at.
3. **You will keep credentials secret.** Account and proxy credentials
   are stored in the configured account database; any cleartext
   material shown during setup or provisioning must be protected like
   SSH keys.
4. **You are responsible for your users.** If you create accounts for
   third parties, the terms of use you offer them, the data you log,
   and the lawful-intercept obligations of your jurisdiction are
   yours to handle.
5. **You assume all risk** arising from running this software on your
   own hardware or any hardware you have permission to use.

## Licence and no-warranty

This software is licensed under the **[GNU Affero General Public
License v3.0 only (AGPL-3.0-only)](https://www.gnu.org/licenses/agpl-3.0.txt)**,
Copyright (C) 2026 coolwhite LLC. See [LICENSE](./LICENSE) for
the full verbatim text.

> *This project belongs to the community. coolwhite LLC chooses
> transparency over profit, and freedom over control.*

Three AGPL-3.0-only clauses worth highlighting before you deploy:

- **Copyleft** (AGPL §§ 2 / 5). You may use, modify, host, and
  redistribute this software for any purpose, commercial or
  otherwise. Modifications and derivative works MUST be
  distributed under AGPL-3.0-only.
- **Network-source-disclosure** (AGPL § 13 — the "A" in AGPL).
  If you operate a modified version of this software as a network
  service (e.g. a paid proxy hosted for users), you MUST make the
  modified source code available to those users. This closes the
  SaaS loophole left open by vanilla GPL-3.
- **No warranty, no liability** (AGPL §§ 15–16). The software is
  provided "AS IS" without any warranty. The non-legal practical
  guidance in this disclaimer's "Operator responsibility" section
  above is not a substitute for the formal warranty disclaimer in
  the LICENSE file. coolwhite LLC and contributors are not liable
  for any damages, claims, or legal consequences arising from your
  deployment, your users' activities, or any third party's use of
  this software.

Versions tagged before this license change retain their original
licenses for anyone who downloaded them:

- **v0.0.58, v0.0.59, v0.0.60** — AGPL-3.0-or-later
- **v0.0.61, v0.0.62** — PolyForm Noncommercial 1.0.0
- **v0.0.63 onward** — AGPL-3.0-only, Copyright (C) 2026 coolwhite LLC

The third-party open-source components this stack builds and runs
(Caddy, sing-box, Bun, Hono, Better Auth, the SQLx / hyper / tokio /
redis crate families, MariaDB, Redis) retain their
own upstream licences and must be preserved in any
redistribution — see [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)
and [NOTICE](./NOTICE).

The Software is provided **without any warranty** — express or
implied — including without limitation the warranties of
merchantability, fitness for a particular purpose, and non-infringement.

## No liability

In no event shall the authors, contributors, or copyright holders be
liable for any claim, damages, or other liability — whether in an
action of contract, tort, or otherwise — arising from, out of, or in
connection with the software or the use or other dealings in the
software.

## Data handling

COOL TUNNEL SERVER, by design, processes proxy traffic on behalf of
its users. The default configuration:

- **Logs no request URLs or response bodies.** Only aggregate per-user
  byte counters (uplink / downlink) and connection counts are recorded
  for quota enforcement.
- **Keeps the Rust core behind local-only process/socket boundaries.**
- **Uses VLESS+Reality camouflage**, so unauthenticated probes do not
  receive an admin or proxy-management surface.
- **Stores no payment data, real names, or device identifiers.** The
  panel only asks for an admin email used for ACME registration.

The operator can choose to log more (e.g. enable Caddy access logs)
or less. Any additional logging beyond the defaults is entirely the
operator's choice and responsibility — including the obligation to
disclose it to users where the law requires.

## Bundled components

COOL TUNNEL SERVER builds and runs the following third-party software
unmodified. Their licenses are reproduced or referenced in
[NOTICE](./NOTICE) and must be preserved in any redistribution:

- [Caddy](https://github.com/caddyserver/caddy) — Apache-2.0
  (stock; ACME provider only — manages the TLS cert via Let's
  Encrypt and writes it to a shared volume that sing-box reads)
- [sing-box](https://github.com/SagerNet/sing-box) — GPL-3.0
  (the actively-maintained proxy runtime we use; bundled as a
  separate process, not statically linked)
- [Bun](https://github.com/oven-sh/bun) — MIT
- [Hono](https://github.com/honojs/hono) — MIT
- [Better Auth](https://github.com/better-auth/better-auth) — MIT

## Reporting security issues

Please report vulnerabilities **privately** via a
[GitHub Security Advisory](https://github.com/coo1white/cool-tunnel-server/security/advisories/new)
rather than as a public issue.
