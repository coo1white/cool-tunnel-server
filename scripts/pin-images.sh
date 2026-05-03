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
mappings=(
    "docker/caddy/Dockerfile|caddy:2.8.4-alpine"
    "docker/sing-box/Dockerfile|alpine:3.20"
    "docker/core/Dockerfile|rust:1.86-alpine"
    "docker/core/Dockerfile|alpine:3.20"
    "docker/panel/Dockerfile|php:8.3-fpm-alpine"
)

pin() {
    local file="$1" image="$2"
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
