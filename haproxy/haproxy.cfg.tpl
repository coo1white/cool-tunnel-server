# Cool Tunnel Server — HAProxy SNI router.
#
# What this HAProxy does:
#
#   - Owns :443 on the public interface.
#   - Sniffs the SNI server_name from each incoming TLS ClientHello
#     WITHOUT decrypting the connection (TCP mode, ssl-passthrough).
#   - Forwards the raw TLS bytes to one of two backends based on SNI:
#
#         SNI = {{ .PanelDomain }}   →  caddy:8444   (admin panel,
#                                                    Caddy reverse-
#                                                    proxies to the
#                                                    panel container's
#                                                    FrankenPHP on
#                                                    :9000)
#         SNI = {{ .Domain }}        →  sing-box:443 (NaiveProxy)
#         (anything else)            →  sing-box:443 (default; matches
#                                                    NaiveProxy probe-
#                                                    resistance — an
#                                                    unrecognised SNI
#                                                    is forwarded to
#                                                    the proxy and
#                                                    rejected with the
#                                                    same shape as a
#                                                    failed proxy auth)
#
# Why TCP mode (not HTTP):
#
#   Each backend terminates its own TLS:
#     - sing-box terminates TLS for {{ .Domain }} using the cert
#       Caddy obtained for the apex via HTTP-01.
#     - Caddy terminates TLS for {{ .PanelDomain }} using its own
#       auto-HTTPS-managed cert for the panel subdomain.
#
#   HAProxy sees only the encrypted bytes; the cipher / JA3 / JA4
#   fingerprint observed on the wire is whatever the backend
#   negotiates with the client. Anti-tracking probe-resistance is
#   preserved end-to-end.
#
# Why a 5-second inspect-delay:
#
#   `tcp-request inspect-delay 5s` lets HAProxy buffer the first
#   ClientHello packet so `req_ssl_sni` can extract the SNI before
#   routing. 5 s is well above any realistic TLS handshake gap and
#   gives no signal to a probe that this isn't a real backend (a
#   too-tight delay would race the slowest legitimate clients).
#
# Why no `default_backend` falls to the panel:
#
#   The panel's Filament login is a brute-force surface. Routing
#   unknown SNI to the panel would let any probe with no SNI
#   (`openssl s_client -connect host:443` with no `-servername`)
#   land on the login page. Routing the default to sing-box
#   instead means an unauthorised probe gets the same "you got
#   the proxy auth wrong" rejection a real NaiveProxy client gets
#   on bad creds — nothing distinguishes the unknown-probe from
#   a brute-force-failure.
#
# (R1-1 / R1-2 in 2026-05-04 audit; landed in v0.0.33.)

global
    log stdout format raw daemon
    daemon
    maxconn 4096
    # No `tune.ssl.*` or `ca-base` — we do NOT terminate TLS here.

    # Cycle 2 / 5 drift-detection probe (v0.0.43, mode-fix v0.0.52)
    # — UNIX stats socket, read-only-stats privilege level. The
    # socket file lands in /var/run/haproxy inside this container,
    # which docker-compose.yml mounts as a shared `haproxy_admin`
    # volume so the panel container can reach it RO. The probe in
    # manifests/haproxy.upstream.json sends `show info` over the
    # socket via socat and greps the `Version:` line — drift
    # surfaces on the Filament Components page within ~100 ms of a
    # Re-check. `level user` is the minimum privilege that allows
    # `show *` commands; it does NOT permit `disable server` /
    # `set server` / `add backend` etc., so a buggy probe cannot
    # mutate runtime state.
    #
    # mode 666 (NOT 660) — v0.0.52 raised this from group-readable
    # to world-readable. The panel container has multiple processes
    # under different users (supervisord/ct-server-core daemon as
    # root; php-fpm workers as www-data; nginx workers as nginx),
    # and the Filament Components page invokes the probe via
    # PHP-FPM (www-data), NOT root. With mode 660 owned by
    # haproxy:haproxy, www-data couldn't connect — the CLI probe
    # via `docker compose exec` (which defaults to root) showed
    # OK while the panel UI showed NG. The "world" that can read
    # this socket is bounded by the docker volume's mount points
    # (haproxy + panel only); mode 666 within that boundary is the
    # right blast-radius given level-user gives no mutation power.
    # Pre-v0.0.52 this was 660 — overcautious for the actual
    # threat model.
    stats socket /var/run/haproxy/admin.sock mode 666 level user

defaults
    mode tcp
    timeout connect 5s
    timeout client 1m
    timeout server 1m
    log global
    # Anti-fingerprinting: do not log per-connection SNI / source IP /
    # backend choice. Forensic risk on seizure outweighs the operator
    # debugging convenience. Caddy + sing-box still log their own
    # connection state at warn-or-higher; HAProxy is layer 4 and an
    # operator who needs per-connection routing detail can re-enable
    # `option tcplog` on a temporary debug rebuild.
    option dontlognull

frontend tls_sni_router
    bind :443
    mode tcp
    tcp-request inspect-delay 5s
    tcp-request content accept if { req_ssl_hello_type 1 }

    # Route by SNI. The `-i` flag is case-insensitive — DNS is case-
    # insensitive and a probe that lowercases the SNI must match the
    # same backend a normal browser sees.
    use_backend panel_caddy if { req_ssl_sni -i {{ .PanelDomain }} }
    default_backend naive_singbox

backend panel_caddy
    mode tcp
    server caddy_panel caddy:8444 check inter 10s rise 2 fall 3

backend naive_singbox
    mode tcp
    server singbox sing-box:443 check inter 10s rise 2 fall 3
