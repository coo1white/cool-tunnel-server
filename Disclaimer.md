# Disclaimer

COOL TUNNEL SERVER is the **server-side** companion to the
[Cool Tunnel](https://github.com/coo1white/cool-tunnel) macOS client.
It bundles a sing-box `naive` inbound (multi-user, ACME, hot-reload
via clash API) with a Filament admin panel for proxy account
management, fake-site camouflage, traffic accounting, and
sing-box config generation.

It is provided **as-is**, for educational and research purposes only.

## Intended use

This software is intended for legitimate uses such as:

- Operating a personal proxy on infrastructure **you own** or are
  **explicitly authorised** to use.
- Learning how sing-box's `naive` inbound, the NaiveProxy protocol,
  and the HTTP/2 CONNECT path interact with TLS termination and ACME.
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
3. **You will keep proxy credentials secret.** Per-user passwords are
   stored hashed in your panel database; the cleartext is generated
   once at account creation and shown only once. Anyone with cleartext
   credentials can use the proxy as that user — protect them like SSH
   keys.
4. **You are responsible for your users.** If you create accounts for
   third parties, the terms of use you offer them, the data you log,
   and the lawful-intercept obligations of your jurisdiction are
   yours to handle.
5. **You assume all risk** arising from running this software on your
   own hardware or any hardware you have permission to use.

## Licence and no-warranty

This software is licensed under the **GNU Affero General Public
License v3.0 or later (AGPL-3.0-or-later)**, copyright (c) 2026
the Cool Tunnel Server contributors. See [LICENSE](./LICENSE) for the full terms.

Two AGPL clauses worth highlighting before you deploy:

- **Source-availability on network use** (AGPL § 13). If you
  modify this software and run a modified version as a service
  that other people interact with over a network, you must offer
  those users the corresponding modified source under the same
  AGPL terms. Stock unmodified deployments don't trigger this —
  you can run the upstream code without any source-distribution
  obligation. Modifying it AND running it as a service does.
- **No warranty** (AGPL §§ 15–16). The software is provided
  "AS IS", without warranty of any kind. The non-legal practical
  guidance in this disclaimer's "Operator responsibility" section
  above is not a substitute for the formal warranty disclaimer
  in the LICENSE file.

The third-party open-source components this stack builds and runs
(Caddy, NaiveProxy, Laravel, Filament, predis/predis, the SQLx /
hyper / tokio / redis crate families, MariaDB, Redis) retain their
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
- **Strips `Forwarded`, `X-Forwarded-*`, and `Via` headers** at the
  Caddy `forward_proxy` layer (`hide_ip` + `hide_via`).
- **Enables `probe_resistance`**, so that unauthenticated probes see
  only the configured fake site and no proxy fingerprint.
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
  (the actively-maintained NaiveProxy server we use; bundled as a
  separate process, not statically linked; reads the cert Caddy
  writes)
- [NaiveProxy](https://github.com/klzgrad/naiveproxy) server-side plugin — Apache-2.0
- [Laravel](https://github.com/laravel/laravel) — MIT
- [Filament](https://github.com/filamentphp/filament) — MIT

## Reporting security issues

Please report vulnerabilities **privately** via a
[GitHub Security Advisory](https://github.com/coo1white/cool-tunnel-server/security/advisories/new)
rather than as a public issue.
