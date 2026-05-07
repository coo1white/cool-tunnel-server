#!/usr/bin/env bash
# pin-images.sh — resolve docker base-image tags to digests and
# update the Dockerfiles in place. LTSC reproducibility — the tag
# `caddy:2.8.4-alpine` can drift if Docker Hub republishes the tag,
# but `caddy:2.8.4-alpine@sha256:...` cannot.
#
# Run this on a host where docker can pull. It rewrites the FROM
# lines in docker/*/Dockerfile to include @sha256:... pins.
#
# Idempotent. Safe to commit the result.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=lib.sh
. scripts/lib.sh

require_cmd docker "Install per docs/installation-debian.md"

# Map of files → (search, image-spec).
# Each entry: dockerfile_path | tag-without-digest
#
# Round-18 dep-hygiene refresh: rust:1.86 → 1.88 (matches
# rust-toolchain.toml after v0.0.x bump), php:8.3-fpm → FrankenPHP
# (post-v0.0.58 panel runtime swap), and added haproxy
# (introduced in v0.0.33 SNI-router split). The stale entries
# previously caused silent misses: `make pin-images` ran without
# error but didn't pin the panel runtime or rust builder, defeating
# the script's purpose. The `pin` function now fails loudly if a
# mapping doesn't match any FROM line in the target file (see
# below).
mappings=(
    "docker/caddy/Dockerfile|caddy:2.8.4-alpine"
    "docker/sing-box/Dockerfile|alpine:3.20"
    "docker/haproxy/Dockerfile|haproxy:3.0.21-alpine"
    "docker/core/Dockerfile|rust:1.88-alpine"
    "docker/core/Dockerfile|alpine:3.20"
    "docker/panel/Dockerfile|dunglas/frankenphp:1-php8.4-alpine"
)

pin() {
    local file="$1" image="$2"

    # Round-18 hygiene: confirm the FROM line we're about to rewrite
    # actually exists in the target file. Pre-fix, a stale mapping
    # (e.g. `php:8.3-fpm-alpine` after the FrankenPHP swap) silently
    # ran sed against a file that didn't contain that pattern,
    # producing a successful no-op — `make pin-images` reported
    # "pin complete" while the operator-relevant base image was
    # still un-pinned. Fail loud here so a future Dockerfile rename
    # surfaces in the next pin-images run, not in a months-later
    # supply-chain incident.
    if ! grep -qE "^FROM\s+${image}(@sha256:[a-f0-9]+)?(\s|$)" "$file"; then
        die "pin-images mapping out of date: \"${image}\" not found in ${file}" \
            "update scripts/pin-images.sh to match the current FROM line, or remove the mapping if the image is gone"
    fi

    step "Resolving $image"
    local digest
    digest=$(docker buildx imagetools inspect "$image" --format '{{json .Manifest}}' 2>/dev/null \
        | jq -r '.digest // empty')
    if [[ -z "$digest" ]]; then
        # Fall back to manifest inspect for older docker.
        digest=$(docker manifest inspect "$image" 2>/dev/null \
            | jq -r '.manifests[0].digest // .config.digest // empty' \
            | head -1)
    fi
    if [[ -z "$digest" ]]; then
        warn "could not resolve digest for $image — skipping"
        return
    fi
    ok "  $image  →  $digest"
    # Update the FROM line: caddy:2.8.4-alpine → caddy:2.8.4-alpine@sha256:...
    # If a digest is already present, replace it.
    sed -i.bak -E "s#^(FROM\s+)${image}(@sha256:[a-f0-9]+)?(\s|$)#\1${image}@${digest}\3#" "$file"
    rm -f "$file.bak"
}

for entry in "${mappings[@]}"; do
    file="${entry%%|*}"
    image="${entry##*|}"
    pin "$file" "$image"
done

ok "pin complete. Review the diff:  git diff docker/"
