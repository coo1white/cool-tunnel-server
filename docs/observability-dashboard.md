# Rust Core Observability Dashboard

This dashboard targets the `ct-server-core` internal metrics endpoint
(`CT_METRICS_BIND`, recommended `127.0.0.1:9292`). The endpoint is
Prometheus-compatible and mirrors OTel semantic fields in both
`tracing` spans and metric labels. Health telemetry remains
operator-internal: no usernames, account IDs, tokens, or per-user
traffic samples are exported.

## Prometheus Scrape

```yaml
scrape_configs:
  - job_name: ct-server-core
    scrape_interval: 15s
    static_configs:
      - targets: ["127.0.0.1:9292"]
```

## Alert Rules

```yaml
groups:
  - name: ct-server-core-offense-driven
    rules:
      - alert: CtCore80PercentThresholdCrossed
        expr: increase(ct_threshold_80pct_crossings_total[5m]) > 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "ct-server-core crossed an 80% bottleneck threshold"
          description: "Surface={{ $labels.surface }} bottleneck={{ $labels.bottleneck }} crossed the offense-driven 80% threshold."

      - alert: CtCoreBufferNearHardLimit
        expr: ct_buffer_utilization_high_water_basis_points >= 8000
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "ct-server-core frame/header buffer high-water is above 80%"
          description: "Surface={{ $labels.surface }} high-water basis points={{ $value }}."

      - alert: CtCoreDaemonPermitsSaturated
        expr: ct_daemon_handler_permits_used / ct_daemon_handler_permits_total >= 0.8
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "ct-server-core daemon handler permits are near saturation"
          description: "The daemon accept loop is applying backpressure; inspect slow clients and recent warning logs."

      - alert: CtCoreLatencyBudgetNearLimit
        expr: increase(ct_threshold_80pct_crossings_total{bottleneck="latency"}[5m]) > 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "ct-server-core network turn latency crossed 80% of budget"
          description: "Surface={{ $labels.surface }} crossed its latency budget threshold. Check recent WARN logs for the matching otel.network.turn span."

      - alert: CtCoreProtocolFaults
        expr: increase(ct_daemon_fsm_hard_resets_total[5m]) > 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "ct-server-core rejected malformed daemon protocol traffic"
          description: "A daemon connection hit a hard reset. Inspect WARN logs for capped frame_hex/header_hex forensic context."
```

## Grafana Panels

Import these as Prometheus query panels:

| Panel | Query | Unit |
| --- | --- | --- |
| Network turns by surface | `rate(otel_network_turns_total[5m])` | ops/s |
| Last network turn latency | `otel_network_turn_latency_milliseconds` | ms |
| Latency threshold crossings | `increase(ct_threshold_80pct_crossings_total{bottleneck="latency"}[15m])` | short |
| Daemon permits used | `ct_daemon_handler_permits_used` | short |
| Daemon permit utilization | `ct_daemon_handler_permits_used / ct_daemon_handler_permits_total` | percent |
| Buffer high-water | `ct_buffer_utilization_high_water_basis_points / 100` | percent |
| 80% threshold crossings | `increase(ct_threshold_80pct_crossings_total[15m])` | short |
| FSM hard resets | `increase(ct_daemon_fsm_hard_resets_total[15m])` | short |
| Redis subscriber restarts | `increase(ct_redis_subscriber_restarts_total[15m])` | short |
| Coalescer reload fires | `increase(ct_coalescer_fires_total[15m])` | short |

## Trace Correlation

Network turns emit `tracing` spans named `otel.network.turn` with OTel
semantic fields:

- `network.transport`
- `network.protocol.name`
- `rpc.system`
- `rpc.method` for daemon turns once JSON decoding succeeds
- `http.request.method` and `url.path` for HTTP turns
- `ct.frame.policy`
- `ct.buffer.bytes`
- `ct.buffer.limit_bytes`
- `ct.status_code`

Instrumented network surfaces:

- daemon Unix-socket JSON-line reads, including malformed bytes,
  incomplete frames, and read timeouts
- internal `/metrics` HTTP scrapes, including 400/404/405 paths
- sing-box clash API calls (`PUT /configs`, `GET /configs`,
  `GET /metrics`)
- DoH resolver probes, anti-tracking HTTP probes, and service
  health checks for the public proxy path

Normal completion is emitted at `TRACE`. Threshold crossings and parse
failures emit `WARN` and include capped hex dumps (`frame_hex`,
`header_hex`, or `buffer_hex`) for technical suppression diagnostics.

## Silent Log Strategy

Recommended production filter:

```text
RUST_LOG=warn
```

Recommended incident filter:

```text
RUST_LOG=ct_server_core=trace
```

Under normal operation the core is quiet except warnings and command
output required by callers. Detailed packet/header hex dumps appear
only after malformed input, incomplete frames, read timeouts, or 80%
threshold crossings. Hex dumps are capped to 96 bytes so the
diagnostic path cannot be turned into an unbounded allocation path.
