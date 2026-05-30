# Going to China — operator runbook

This runbook is for operators deploying or maintaining a Cool Tunnel
server that needs to survive use from inside the Great Firewall of
China (GFW). It covers what to verify before you leave, what to
verify on first connection, and what to do when something stops
working.

The proxy path uses sing-box VLESS+Reality behind Caddy's SNI
splitter. **The practical failure modes are operational**, not
protocol-level:

1. The VPS IP gets blocked.
2. DNS / DoH resolution path breaks inside the GFW.
3. The cover site fails an active probe.
4. Cert renewal fails because Let's Encrypt is unreachable.

This document covers each.

---

## Before you board the plane

### 1. Switch the DoH resolver to a China-reachable endpoint

The pre-v0.0.57 default was `https://1.1.1.1/dns-query` (Cloudflare).
Cloudflare DoH is intermittently blocked or silently dropped from
mainland China — the daemon's DNS path looks healthy ("connection
open") but every name lookup fails.

In **Settings → Anti-Tracking → DoH Resolver**, switch
to one of:

| Endpoint                                | Reachable from China | Trust profile                   |
|-----------------------------------------|----------------------|----------------------------------|
| `https://dns.alidns.com/dns-query`      | ✓ (Aliyun, in-country) | China-operated; logs may be subpoenable |
| `https://doh.pub/dns-query`             | ✓ (Tencent DNSPod)     | Same                            |
| `https://dns.quad9.net/dns-query`       | partial (often works)  | Independent, Switzerland-based  |
| `https://dns.nextdns.io/<config-id>`    | mostly ✓               | Independent, configurable       |
| `https://1.1.1.1/dns-query`             | ✗ blocked              | (the previous default)          |

If you trust the trip more than the audit trail, **AliDNS** is the
most reliable. If you want independent, **Quad9** sometimes routes
through Hong Kong and works fine. Test both before you commit.

After changing the resolver, click **Save** and confirm `./ct doctor`
passes from the VPS.

### 2. Verify VPS region is reachable / fast from China

Ideal latency from mainland China: **HK (~30 ms), Tokyo (~50 ms),
Singapore (~80 ms)**. Workable: US-West (~150 ms), Europe
(~200-300 ms). Avoid: US-East (~250-400 ms with frequent stalls).

If your current VPS is far from China, consider a fresh deploy in
HK or Tokyo before you go. The Homebrew-style bootstrap command plus
`ct install` makes this a 30-minute task on a clean VPS.

### 3. Run clean health gates + SoT verification

```sh
cd ~/cool-tunnel-server
git pull --ff-only
ct update
./ct doctor                # no FAIL rows?
make manifest-lockstep     # package/Rust/manifest versions aligned?
```

Anything not OK gets fixed BEFORE you leave. Inside China, debug
turnaround takes longer (every roundtrip goes through the same
proxy you're trying to debug).

### 4. Build a backup-access plan for the admin UI

The admin UI is served at `https://<PANEL_DOMAIN>/login`.
Keep an out-of-band management path anyway; if your VPS provider's IP
range gets put on a Chinese block list, you may lose normal SSH access
too.

Two practical mitigations:

- **Second VPS as bastion** — a small box in a different region you
  can always SSH to. From there, SSH-hop to your main VPS via its
  internal/public IP. Costs ~$3/mo extra.
- **Tailscale on the VPS** — out-of-band management plane that
  doesn't touch :443. Install with `curl -fsSL https://tailscale.com/install.sh | sh`,
  then `tailscale up`. Now you can reach the VPS from any device on
  your tailnet, even if SSH-from-public is blocked.

Pick one. Verify it works from a non-China network BEFORE you
travel.

### 5. Pre-stage the subscription URL on every device you'll use

Once inside China, fetching a new subscription URL means reaching
the admin UI while the same network may be hostile. Generate the URL now
for every laptop/phone/tablet you'll travel with, paste into each
client app's subscription input, and verify the connection profile
imports cleanly. You can use the same URL on multiple devices.

### 6. Pick a mobile client

Cool Tunnel's official iOS/Android clients are still roadmap work.
For phone-side use right now, pick a maintained sing-box-compatible
client that can import the admin API's subscription output. Test on your
home network before you fly.

---

## First connection from China — verify in this order

The first time you connect from inside the GFW, run through this
checklist in order. Each step depends on the previous.

```sh
# (1) From your laptop/phone with the proxy active:
curl -s https://www.google.com/generate_204 -o /dev/null -w "%{http_code}\n"
# Expect: 204 (proxy is working end-to-end)

# (2) Same surface for Claude.ai:
curl -s https://claude.ai/ -o /dev/null -w "%{http_code}\n"
# Expect: 200 or 302

# (3) SSH to VPS, then from inside the VPS:
./ct doctor
# Expect: no FAIL rows

# (4) Confirm sing-box has no recent fatals:
docker compose logs --tail=50 singbox | grep -iE 'error|fatal' | tail -5
# Expect: empty (or only warn-level retries)
```

If any step fails, the most likely culprit is the DoH resolver
(see step 1 of the pre-departure checklist). Switch it in Settings,
run `ct render singbox`, and re-test.

---

## When something stops working

Read symptoms left-to-right. First match wins.

| Symptom | Likely cause | First action |
|---|---|---|
| Connection times out from every client | VPS IP blocked OR cert expired | `ssh root@vps` from a non-China network -> if SSH works, run `./ct doctor` |
| Connection works from one network, not another | Carrier-level domain block | Try a different network (mobile data vs WiFi). If carrier-only, no fix on server side. |
| Connection hangs after TLS handshake | Active-probing in progress, sing-box slow to respond | `docker compose logs singbox \| grep "active-probe"` if probe logging is enabled. Restart sing-box: `docker compose restart singbox`. |
| Some sites work, others don't | DNS resolution failing | Switch DoH resolver in Settings. AliDNS most reliable. |
| All sites resolve but pages don't load | Latency / packet loss between China and VPS | Likely VPS region too far. Consider HK / Tokyo VPS. |
| Cert errors in client | Let's Encrypt renewal failed | SSH in, `docker compose logs caddy \| grep -i acme \| tail -20`. If ACME failed, swap ACME directory to ZeroSSL: `ACME_DIRECTORY=https://acme.zerossl.com/v2/DV90` in `.env`, then `ct update`. |
| Admin UI shows the wrong site | Caddy SNI route or `PANEL_DOMAIN` mismatch | Check `.env`, DNS for `PANEL_DOMAIN`, and `docker compose logs caddy`. |

If the entire VPS is unreachable from China but reachable from
elsewhere, the IP is likely on a Chinese block list. There's no
quick fix — you need to either:

- **Spin up a new VPS** with a different IP (different provider
  preferred — RackNerd, DigitalOcean, and Vultr ranges are flagged
  in batches; Hetzner / OVH / niche HK providers tend to last
  longer).
- **Update the domain's A record** to point at the new IP.
- **Wait for low TTL** — keep your domain's DNS TTL at 300 seconds
  (5 min) so failover heals fast. A 1-day TTL means a day of
  downtime per reprovision.

---

## Ongoing health checks

Run the health gate from the VPS when connectivity looks strange:

```sh
ct doctor
```

For deeper service state:

```sh
./ct doctor
docker compose ps
docker compose logs --tail=120 caddy
docker compose logs --tail=120 singbox
docker compose logs --tail=120 admin-api
docker compose logs --tail=120 admin-web
```

Map the common failures this way:

| Signal | Likely cause | First action |
|---|---|---|
| DoH resolver check fails | DoH endpoint unreachable from VPS | Switch DoH resolver in Settings |
| `singbox` restarting | Rendered config or upstream binary issue | `docker compose logs --tail=120 singbox` |
| Caddy ACME errors | DNS, port 80, or ACME provider issue | Check DNS, firewall, and `docker compose logs caddy` |
| Admin health fails | Admin API/web, config, or SQLite issue | `docker compose logs --tail=120 admin-api admin-web` |

---

## Active-probing detector (v0.0.57+)

When the GFW or other adversaries actively probe your server, you
see characteristic patterns:

- Many connections from a single source IP within seconds
- Connections that close immediately after the TLS handshake (no
  HTTP request)
- Repeated failed-auth attempts from the same source

The daemon now logs a `probe.detected` event at warn level when
> 30 cover-site fall-throughs occur from a single source IP within
60 seconds:

```
docker compose logs admin-api | grep probe.detected | tail -20
```

This isn't a block list — it's an early signal. If you see a
sustained pattern from many sources over hours, your server is
under deliberate scrutiny and you should consider rotating the
domain.

---

## Domain hygiene (long-term)

The GFW maintains a list of domains-known-to-host-proxies and
poisons their DNS responses inside China. Your domain doesn't need
to look "innocent" — it needs to not yet be on the list.

**What helps:**

- A boring TLD: `.com`, `.net`, `.org` over `.xyz`, `.click`, `.top`.
  The latter group is over-represented in proxy operations and gets
  flagged in batches.
- Some operating history: a domain you've owned for 6+ months with
  some HTTP traffic on it (even if just the cover site) raises less
  flags than a brand-new registration.
- A subdomain of a domain you use for other things: e.g.,
  `proxy.your-real-business.com` is more credible than
  `tunnel-2026.xyz`.

**What hurts:**

- Domains that previously hosted known proxy projects.
- Free dynamic-DNS services (`*.duckdns.org`, etc.) — easy to flag
  by hostname pattern.
- Cloudflare-fronted domains where the apex has been on a
  blocklist (the GFW drops Cloudflare-fronted IPs heavily).

If your current domain gets blocked, register a new one and update
the A record. Keep the old domain on standby for ~30 days; if it
unblocks (rare but happens), you can rotate back.

---

## Last resort — when everything fails

If the entire path is broken (DoH won't resolve, IP is blocked,
domain is poisoned), and you need access to your own VPS to fix
it:

1. Connect to the bastion VPS or Tailscale exit node you set up in
   pre-departure step 4.
2. From the bastion, SSH to your main VPS by its raw IP (no DNS
   needed — DNS resolution failure doesn't affect IP-based SSH).
3. Once in, edit `.env` or use the admin UI/API settings, then run
   `ct render caddyfile`, `ct render singbox`, and `ct update`.

Without a bastion / Tailscale, your only recourse is to find a
working proxy elsewhere (a friend's, a commercial VPN that still
works) and use it to reach your VPS. Plan ahead.

---

## When to ask for an architectural upgrade

The single-server architecture in v0.0.x has known limits for
adversarial environments. A v0.1 epic on multi-server orchestration
(admin UI manages a fleet, picks healthiest endpoint, automatic IP
rotation via cloud-provider APIs) addresses these.

If you find yourself rotating VPS more than once a month, that
epic is the right next investment. Until then, this single-server
deployment plus the pre-departure checklist above is the most
defensible setup the v0.0.x line offers.
