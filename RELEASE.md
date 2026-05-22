# Release process

How to cut a release of Cool Tunnel Server. Aimed at "future me
two years from now" who has forgotten everything; runnable as a
checklist.

## Prerequisites

- Push permission to `coo1white/cool-tunnel-server`
- `gh` CLI authenticated as `coo1white`
- Local Rust toolchain matching `core/rust-toolchain.toml`
- Local Docker/Buildx Linux builder for release assets. A Lima VM is
  fine. The release must not depend on compiling Rust on a user's VPS.

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

Four places need to agree:

```sh
# Cargo workspace.
$EDITOR core/Cargo.toml          # workspace.package.version

# Component manifests.
$EDITOR manifests/ct-server-core.upstream.json
$EDITOR manifests/ct-protocol.upstream.json
$EDITOR manifests/panel.upstream.json

# Panel runtime version constant — what the `ct:version` artisan
# command emits. Keep it aligned with manifests/panel.upstream.json.
$EDITOR panel/config/cool-tunnel.php   # 'version' => 'X.Y.Z'
```

`Makefile` provides `make set-version V=0.0.X` to update all four
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

### 8. Build release binaries locally

Build the Linux `ct-server-core` assets before publishing the release.
Use mirror overrides when Docker Hub or Alpine CDN routing is poor:

```sh
BUILDER=rootless \
CT_RUST_BASE_IMAGE=public.ecr.aws/docker/library/rust:1.88.0-alpine \
CT_ALPINE_BASE_IMAGE=public.ecr.aws/docker/library/alpine:3.20 \
CT_ALPINE_REPOSITORY_BASE=https://mirrors.aliyun.com/alpine \
./scripts/build_release_core_assets.sh
```

The script writes:

- `release-assets/ct-server-core-linux-x64`
- `release-assets/ct-server-core-linux-arm64`
- `release-assets/SHA256SUMS.core`

Verify the assets before upload:

```sh
file release-assets/ct-server-core-linux-*
sha256sum -c release-assets/SHA256SUMS.core
```

### 9. Create GitHub release

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

### 10. Attach release assets

Upload locally built core assets first, then let GitHub's
`ct-operator release` workflow upload the operator binaries and merge
`SHA256SUMS`. The final release must contain all of:

- `ct-operator-linux-x64`
- `ct-operator-linux-arm64`
- `ct-server-core-linux-x64`
- `ct-server-core-linux-arm64`
- `SHA256SUMS`

```sh
gh release upload vX.Y.Z release-assets/ct-server-core-linux-* --clobber
gh workflow run "ct-operator release" --ref vX.Y.Z
gh run watch --exit-status "$(gh run list --workflow "ct-operator release" --limit 1 --json databaseId --jq '.[0].databaseId')"
gh release download vX.Y.Z --pattern SHA256SUMS --dir /tmp/ct-release-check --clobber
sha256sum -c /tmp/ct-release-check/SHA256SUMS --ignore-missing
```

### 11. Generate + attach SBOMs

```sh
make sbom
gh release upload vX.Y.Z sbom/cool-tunnel-server-vX.Y.Z-sbom.cdx.json
```

The CycloneDX SBOM lists every Rust crate, Composer package, and
container image layer that goes into the release. Auditors can
diff two releases' SBOMs to see exactly what changed in the supply
chain.

### 12. Pin Docker base images by digest (optional but LTSC-shape)

If docker is available locally:

```sh
make pin-images
```

This resolves the current base-image tags in `operator/pin-images.ts`
to their image digests and updates the Dockerfiles to pin by
`@sha256:...`. Commit the digest update on top of the release commit
(or as a follow-up).

If docker isn't available locally, run `make pin-images` on the
production VPS after `./ct update`.

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
