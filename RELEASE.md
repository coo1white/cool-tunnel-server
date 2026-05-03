# Release process

How to cut a release of Cool Tunnel Server. Aimed at "future me
two years from now" who has forgotten everything; runnable as a
checklist.

## Prerequisites

- Push permission to `coo1white/cool-tunnel-server`
- `gh` CLI authenticated as `coo1white`
- Local Rust toolchain matching `core/rust-toolchain.toml`
- Optional: docker (for image builds + digest pinning)

## The recipe

### 1. Make sure HEAD is clean

```sh
git status                 # should show nothing
git pull --ff-only origin main
```

### 2. Run the local CI gate

```sh
make ci
```

This is what GitHub Actions also runs. It must be green before any
tag is created. Specifically it does:

- `cargo build --release --workspace`
- `cargo test  --release --workspace`
- `cargo clippy --release --all-targets -- -D warnings`
- `cargo fmt   --all -- --check`
- `shellcheck -x scripts/*.sh docker/panel/entrypoint.sh`
- `find panel -name '*.php' | xargs -n1 php -l | grep -v 'No syntax errors'`
- `composer validate panel/composer.json --strict`
- `for f in manifests/*.json; do jq . "$f" >/dev/null; done`

### 3. Update CHANGELOG.md

Move the `## [Unreleased]` block into a new `## [X.Y.Z] — YYYY-MM-DD`
section. Sub-sort by `Added / Changed / Removed / Fixed / Security`.

Update the comparison links at the bottom.

### 4. Bump versions

Three places need to agree:

```sh
# Cargo workspace.
$EDITOR core/Cargo.toml          # workspace.package.version

# Component manifests.
$EDITOR manifests/ct-server-core.upstream.json
$EDITOR manifests/ct-protocol.upstream.json
$EDITOR manifests/panel.upstream.json
```

`Makefile` provides `make set-version V=0.0.X` to update all three
in one go.

### 5. Re-run CI

```sh
make ci
```

Yes, again. The version bump can break a doctest that hard-coded
the old version string.

### 6. Commit + tag

```sh
git add -A
git commit -m "release vX.Y.Z

Headline summary, copied from CHANGELOG section."
git tag -a vX.Y.Z -m "vX.Y.Z — short description (pre-release)"
```

### 7. Push

```sh
git push origin main
git push origin vX.Y.Z
```

### 8. Create GitHub release

```sh
gh release create vX.Y.Z \
    --repo coo1white/cool-tunnel-server \
    --prerelease \
    --title "vX.Y.Z — short description" \
    --notes-file <(awk '/^## \[X\.Y\.Z\]/,/^## \[/' CHANGELOG.md \
                   | sed '$d')
```

Mark `--prerelease` until you (or a designated operator) have run
the new release on real metal and `late-night-comeback.sh` reports
≥ 80%. After that, edit the release on the GitHub UI to drop the
pre-release flag.

### 9. Generate + attach SBOMs

```sh
make sbom
gh release upload vX.Y.Z sbom/cool-tunnel-server-vX.Y.Z-sbom.cdx.json
```

The CycloneDX SBOM lists every Rust crate, Composer package, and
container image layer that goes into the release. Auditors can
diff two releases' SBOMs to see exactly what changed in the supply
chain.

### 10. Pin Docker base images by digest (optional but LTSC-shape)

If docker is available locally:

```sh
make pin-images
```

This resolves the current `caddy:2.8.4-alpine`, `alpine:3.20`,
`rust:1.86-alpine`, etc. tags to their image digests and updates
the Dockerfiles to pin by `@sha256:...`. Commit the digest update
on top of the release commit (or as a follow-up).

If docker isn't available locally, run `make pin-images` on the
production VPS after `./scripts/update.sh`.

### 11. Announce

Update the release notes on GitHub with anything that didn't fit
in the tag message. If there's a security issue, also publish a
GHSA via the Security tab.

## Reproducing a release bit-for-bit

For a given tag `vX.Y.Z`:

```sh
git checkout vX.Y.Z

# Rust core: deterministic with the lockfile.
( cd core && cargo build --release --workspace --locked )

# PHP panel: deterministic with composer.lock.
( cd panel && composer install --no-dev --no-interaction --prefer-dist )

# Docker images: deterministic with digest-pinned base images.
docker compose --profile build-only build core-builder
docker compose build
```

Compare to the SBOM attached to the release. Any divergence is
either a Cargo.lock / composer.lock change (reproducible:
deterministic), or a base-image digest change (only reproducible
if `make pin-images` was run on the original release).

## Hotfix workflow

For a security or critical-bug fix on a supported version line:

1. Branch from the tag: `git checkout -b hotfix/vX.Y.Z+1 vX.Y.Z`.
2. Make the minimal fix. NO other changes.
3. Update CHANGELOG.md for the new patch version.
4. `make ci`.
5. Tag `vX.Y.Z+1`, push, release.
6. Optionally cherry-pick the fix forward to `main` if it's still
   relevant there.
