# Throwaway-VPS test runbook

End-to-end smoke test on a real VPS before pushing a release to
production. Catches the things `cargo test`, `bun test`, and
`make ci` structurally can't:

- Panel entrypoint completes inside its 90 s sentinel window on a
  1 vCPU box.
- `singbox-core render-server` produces a parse-clean
  `/data/config/singbox.json` from a live DB.
- Let's Encrypt ACME succeeds on the real DNS + public IP.
- A real macOS client can import the subscription URL and proxy
  traffic through it.
- `ct doctor` reports a clean PASS / WARN / FAIL dashboard.

If you only need the local CI gates (Rust + PHP + operator
typecheck + drift detectors), use `make ci` instead — it's faster
and runs without a VPS.

## What you need

- A throwaway VPS — Debian 12 or newer, 1 vCPU / 1 GB RAM. Vultr /
  RackNerd / Hetzner all work; budget ~$3-5/month, billed hourly.
- A throwaway DNS zone you control. Two A records:
  `test.<your-zone>` and `panel.test.<your-zone>`, both pointing at
  the VPS's public IPv4.
- Throwaway credentials: **never** use production
  `MAIL_USERNAME` / `MAIL_PASSWORD` / `ACME_EMAIL` here. Use a
  scratch inbox and a scratch ACME email.

## Steps

### 1. Provision the VPS, point DNS at it

```sh
# From your laptop, after the VPS IP is known and DNS is set:
dig +short A test.your-zone.com
dig +short A panel.test.your-zone.com
# Both must return the VPS IP. If not, wait 5-15 min for propagation.
```

Don't continue until both `dig` lookups return the VPS IP. ACME
will fail at step 4 otherwise.

### 2. Bootstrap + install

Follows [`GETTING_STARTED.md`](../GETTING_STARTED.md) verbatim —
nothing test-specific:

```sh
ssh root@YOUR_VPS_IP
apt update
apt install -y ca-certificates curl git gnupg jq openssl apache2-utils ufw dnsutils chrony fail2ban unattended-upgrades
LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"
BRANCH="${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/${LATEST}/scripts/bootstrap.sh")"
cd /opt/cool-tunnel-server && nano .env
#   DOMAIN=test.your-zone.com
#   PANEL_DOMAIN=panel.test.your-zone.com
#   ACME_EMAIL=scratch@your-zone.com
ct install
```

Expect ~10-15 min on the install step on a 1 vCPU VPS.

### 3. Health gate

```sh
ct doctor
```

The health gate is the canonical "ready to inspect" pass.
It fails fast on structural / operational / functional defects
that an operator wouldn't otherwise see until a client tried to
connect.

### 4. Live ACME confirmation

```sh
docker compose logs caddy 2>&1 | grep -iE 'obtaining certificate|certificate obtained|certificate signing'
```

Should show successful cert issuance for both `${DOMAIN}` and
`${PANEL_DOMAIN}`. A 404 or rate-limit response here typically
means the DNS step propagated incompletely or the `ACME_EMAIL` is
malformed.

### 5. Create a test proxy account + import subscription

Browser → `https://panel.test.your-zone.com/admin` → log in as
`holder` with `CT_BOOTSTRAP_ADMIN_PASSWORD` from `.env`, change the
password when prompted, then go to **Proxy Accounts** →
**New proxy account** → username `demo-user` → Save.

Copy the **Subscription URL** from the green notification.

On a Mac (or other client platform — see
[`docs/cross-platform-clients.md`](./cross-platform-clients.md)):

1. Install the latest [`cool-tunnel`](https://github.com/coo1white/cool-tunnel/releases) client.
2. Paste the Subscription URL into **Import from subscription URL** → Import.
3. Click **Start**.

The Live log should show:

```
✓ baseline (direct, no proxy) https://www.baidu.com ...
✓ via proxy https://www.google.com/generate_204 ...
```

Both ✓ = end-to-end works.

### 6. Exercise `ct update` on the live deploy

With a working stack, prove that the update flow is intact:

```sh
./ct update
```

On a deployment already at `main` HEAD this is mostly a no-op
(git pull is fast-forward zero, the release image bundle is already
loaded, health gates stay green). It exercises every step in
`operator/update.ts`
against real Docker + the real panel entrypoint, which is the part
that can't be tested locally.

### 7. (Optional) Re-run diagnostics

```sh
./ct doctor
```

Should report no FAIL rows. If it surfaces something, that's a real
finding worth filing.

### 8. Teardown

```sh
# On the VPS: nothing to do — destroy the VPS from the provider's
# control panel. The disk goes with it.

# Optionally clean up DNS:
#   delete the test.<zone> and panel.test.<zone> A records
```

## What this runbook does NOT cover

- Performance under load — there's no synthetic load generator
  here. Use a real client (or several) for a few minutes of real
  traffic if you care about latency under sustained connections.
- Failover / restore. See [`docs/operations.md`](./operations.md)
  for the backup + restore commands; the runbook above does not
  exercise them.
- Cross-architecture (arm64) behaviour. If you're shipping a
  binary built for arm64, repeat steps 2-6 on a matching VPS.
