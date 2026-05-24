# Going To China Runbook

The admin panel is served at `https://<PANEL_DOMAIN>/admin`. The proxy path uses VLESS + Reality through sing-box.

Before travel:

```sh
ct backup
ct update
ct doctor
ct render singbox
```

If the panel is unhealthy:

```sh
docker compose ps panel
docker compose logs --tail=120 panel
ct doctor
```

If generated config is stale:

```sh
ct render singbox
docker compose restart singbox
ct doctor
```
