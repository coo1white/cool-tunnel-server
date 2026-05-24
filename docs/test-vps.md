# VPS Test Notes

Use the normal CI and smoke-test gates for a candidate release:

```sh
LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"
BRANCH="${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/${LATEST}/scripts/bootstrap.sh")"
make ci
docker compose config
ct doctor
```

Fresh installs should end with:

```sh
ct admin bootstrap
```

Open the printed one-time setup URL, create the first owner, and sign in at `https://<PANEL_DOMAIN>/admin`.
