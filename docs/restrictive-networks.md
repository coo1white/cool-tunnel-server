# Operating in restrictive networks — operator runbook

For deploying or maintaining a Cool Tunnel server expected to keep working
across restrictive networks (corporate or hotel filtering, ISP-level DNS
poisoning, regional censorship, active probing). The protocol path
(sing-box VLESS + Reality behind Caddy SNI) is sound; **the practical
failure modes are operational**:

1. The VPS IP gets blocked at the destination network.
2. DNS / DoH resolution breaks on the user's network.
3. The cover site fails an active probe.
4. Cert renewal fails because Let's Encrypt is unreachable from the VPS.

This runbook covers each.

---

## Before you deploy / travel

### 1. Pick a DoH resolver that the user's network can reach

The default (`https://dns.alidns.com/dns-query`) is widely reachable. If
the deployment serves a network where this is blocked, set
**Settings → Anti-Tracking → DoH Resolver** to an alternative and verify:

| Endpoint                                | Notes                                      |
|-----------------------------------------|--------------------------------------------|
| `https://dns.quad9.net/dns-query`       | Independent (Switzerland); often routes via low-latency PoPs |
| `https://dns.nextdns.io/<config-id>`    | Configurable, per-account filtering        |
| `https://doh.opendns.com/dns-query`     | Cisco-operated; broadly reachable          |
| `https://1.1.1.1/dns-query`             | Cloudflare; blocked or dropped on some networks |

After changing, click **Save** and confirm `ct doctor` still passes.
Pick a resolver appropriate for the threat model: a third-party that
logs is fine for low-sensitivity use; pair with **anti-tracking ↳ hide IP**
when it matters.

### 2. VPS region: close + reachable

Lowest-latency VPS region that the destination network can reach
reliably. Restrictive networks often have asymmetric reachability — a
provider that's fast for users elsewhere may be slow or blocked from
specific networks. Test before committing:

```sh
# from the user's network
curl -o /dev/null -s -w 'connect=%{time_connect} ttfb=%{time_starttransfer}\n' https://<PANEL_DOMAIN>/up
```

If the VPS is far from the user, a fresh deploy closer to them is a
30-minute task (`bootstrap.sh` → `ct install`).

### 3. Clean health gates before exposing to a hostile network

```sh
cd /opt/cool-tunnel-server
ct backup && ct update && ct doctor      # all PASS; WARNs read in context
```

Anything not OK gets fixed first. Debugging through the same proxy
you're trying to fix is slow and painful.

### 4. Out-of-band management plane

If the VPS provider's IP range gets blocked at the destination network,
public SSH may go too. Keep a path that doesn't depend on the proxy:

- **Bastion VPS** — a small box in a different region you can always reach,
  then SSH-hop to the main VPS. ~$3/mo.
- **Tailscale on the VPS** — `curl -fsSL https://tailscale.com/install.sh | sh && tailscale up`.
  Reaches the VPS from any tailnet device without touching `:443`.

Pick one. **Verify from a different network before you need it.**

### 5. Pre-stage subscription URLs

Generate the **Subscription URL** for each device (laptop/phone/tablet)
from a stable network, import into each client, confirm the profile
imports. Same URL works on multiple devices.

### 6. Pick a client

Use the official Cool Tunnel client where available, or any maintained
sing-box-compatible client that can import the admin API's subscription
output. Test on a stable network before relying on it.

---

## First connection from a restrictive network — verify in order

Each step depends on the previous.

```sh
# (1) From a client with the proxy active:
curl -s https://www.google.com/generate_204 -o /dev/null -w "%{http_code}\n"
# Expect: 204 (proxy reachable end-to-end)

# (2) An app you actually care about:
curl -s https://<some-target>/ -o /dev/null -w "%{http_code}\n"

# (3) SSH to the VPS (via out-of-band path if direct SSH is blocked):
ct doctor                                  # no FAIL rows

# (4) Recent sing-box fatals?
docker logs --tail=50 ct-singbox | grep -iE 'error|fatal' | tail -5
# Expect: empty (or only transient warn-level retries)
```

If any step fails, the most common cause is DoH (see §1). Switch the
resolver in Settings; the change re-renders the live config automatically
(v0.6.1+).

---

## When something stops working

Read symptoms left-to-right; first match wins.

| Symptom | Likely cause | First action |
|---|---|---|
| Times out from every client | VPS IP blocked, or cert expired | Reach VPS via out-of-band path → `ct doctor` |
| Works on one network, not another | Carrier-level filtering of the destination | Try another network (mobile vs WiFi). Carrier-side fix only. |
| Hangs after TLS handshake | Active probing, or sing-box slow to respond | `docker logs ct-singbox`; `docker restart ct-singbox` |
| Some sites work, others don't | DNS resolution failing for the failing ones | Switch DoH resolver in Settings |
| All sites resolve but pages don't load | Latency / packet loss between user and VPS | VPS region too far — consider a closer region |
| Cert errors in client | Let's Encrypt renewal failed | `docker logs ct-caddy | grep -i acme | tail -20`. Try ZeroSSL: `ACME_DIRECTORY=https://acme.zerossl.com/v2/DV90` in `.env`, then `ct update` |
| Admin UI shows the wrong site | Caddy SNI route or `PANEL_DOMAIN` mismatch | Check `.env`, DNS for `PANEL_DOMAIN`, `docker logs ct-caddy` |

If the VPS is unreachable from the destination network but reachable
from elsewhere, the IP is likely blocked there. There's no fast
in-place fix — rotate:

- **Spin up a new VPS** with a different IP. Prefer a different provider —
  some provider IP ranges get flagged in batches.
- **Update the domain's A record** to the new IP.
- **Keep DNS TTL low** (300s). A 1-day TTL means a day of downtime per
  reprovision.

---

## Ongoing health checks

```sh
ct doctor
docker ps
docker logs --tail=120 ct-caddy
docker logs --tail=120 ct-singbox
docker logs --tail=120 ct-admin-api
docker logs --tail=120 ct-admin-web
```

| Signal | Likely cause | First action |
|---|---|---|
| DoH resolver check fails in doctor | DoH endpoint unreachable from VPS | Switch resolver in Settings |
| `singbox` restarting | Rendered config or upstream issue | `docker logs ct-singbox` |
| Caddy ACME errors | DNS, port 80, or ACME provider issue | `docker logs ct-caddy`; check firewall |
| Admin health fails | Admin API/web, config, or SQLite | `docker logs ct-admin-api ct-admin-web` |

---

## Domain hygiene (long-term)

Adversarial networks often maintain lists of domains known to host
proxies, and either poison DNS or null-route the IPs. Your domain
doesn't need to look "innocent" — it needs to not yet be on a list.

**Helps:**

- A boring TLD (`.com`, `.net`, `.org`) over `.xyz`, `.click`, `.top` —
  the latter are over-represented in proxy operations and get flagged
  in batches.
- Some operating history: a domain owned for 6+ months with HTTP
  traffic (even just the cover site) raises less suspicion than a
  brand-new registration.
- A subdomain of a domain used for unrelated things
  (`proxy.your-real-business.com`) over a single-purpose name
  (`tunnel-2026.xyz`).

**Hurts:**

- Domains that previously hosted known proxy projects.
- Free dynamic-DNS hostnames (`*.duckdns.org`, etc.) — easy to flag by
  pattern.
- Cloudflare-fronted domains where the apex has been on a blocklist
  somewhere — fronted IPs get blocked aggressively by some networks.

If a domain gets blocked, register a new one and update the A record.
Keep the old domain on standby for ~30 days in case it unblocks.

---

## Last resort — when everything fails

The entire path is broken (DoH won't resolve, IP is blocked, domain
poisoned) and you need to fix your own VPS:

1. Reach the bastion / Tailscale exit node from §4.
2. From there, SSH to the main VPS by raw IP (no DNS needed).
3. Edit `.env` or fix settings in the admin UI/API, then `ct render caddyfile`,
   `ct render singbox`, `ct update`.

Without an out-of-band path, the only recourse is to reach the VPS
through a different working proxy. **Plan ahead in §4.**
