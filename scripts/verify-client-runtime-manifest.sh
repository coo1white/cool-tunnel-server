#!/usr/bin/env bash
set -euo pipefail

manifest="${1:-manifests/client-runtime.upstream.json}"
server_repo="https://github.com/coo1white/cool-tunnel-server"

if [ ! -f "$manifest" ]; then
    echo "missing client runtime manifest: $manifest" >&2
    exit 1
fi

version="$(jq -r '.version' "$manifest")"
release_tag="$(jq -r '.authority.release_tag' "$manifest")"

if [ "$(jq -r '.kind' "$manifest")" != "portable-runtime" ]; then
    echo "client runtime manifest kind must be portable-runtime" >&2
    exit 1
fi
if [ "$(jq -r '.schema_version' "$manifest")" != "1" ]; then
    echo "client runtime manifest schema_version must be 1" >&2
    exit 1
fi
if [ "$(jq -r '.upstream' "$manifest")" != "$server_repo" ]; then
    echo "client runtime manifest upstream must be $server_repo" >&2
    exit 1
fi
if [ "$(jq -r '.authority.repo' "$manifest")" != "$server_repo" ]; then
    echo "client runtime authority repo must be $server_repo" >&2
    exit 1
fi
if [ "$release_tag" != "v${version}" ]; then
    echo "client runtime authority release_tag drift: $release_tag != v${version}" >&2
    exit 1
fi
if [ "$(jq -r '.authority.checksum_asset' "$manifest")" != "SHA256SUMS" ]; then
    echo "client runtime checksum asset must be SHA256SUMS" >&2
    exit 1
fi

plugins="$(jq -r '.plugins | keys | sort | join(" ")' "$manifest")"
if [ "$plugins" != "cool-tunnel-core sing-box" ]; then
    echo "client runtime plugins drift: $plugins" >&2
    exit 1
fi

for plugin in sing-box cool-tunnel-core; do
    if [ "$(jq -r --arg plugin "$plugin" '.plugins[$plugin].kind' "$manifest")" != "binary" ]; then
        echo "$plugin kind must be binary" >&2
        exit 1
    fi
    if [ "$(jq -r --arg plugin "$plugin" '.plugins[$plugin].upstream' "$manifest")" != "$server_repo" ]; then
        echo "$plugin upstream must be server release authority" >&2
        exit 1
    fi
    if [ "$(jq -r --arg plugin "$plugin" '.plugins[$plugin].assets | keys | sort | join(" ")' "$manifest")" != "darwin-universal" ]; then
        echo "$plugin currently must publish exactly darwin-universal" >&2
        exit 1
    fi

    asset=".plugins[\"$plugin\"].assets[\"darwin-universal\"]"
    filename="$(jq -r "$asset.filename" "$manifest")"
    url="$(jq -r "$asset.url" "$manifest")"
    sha="$(jq -r "$asset.sha256" "$manifest")"
    size="$(jq -r "$asset.size_bytes" "$manifest")"

    if [ "$(jq -r "$asset.platform" "$manifest")" != "darwin-universal" ]; then
        echo "$plugin platform must be darwin-universal" >&2
        exit 1
    fi
    if [ "$(jq -r "$asset.os" "$manifest")" != "darwin" ]; then
        echo "$plugin os must be darwin" >&2
        exit 1
    fi
    if [ "$(jq -r "$asset.arch" "$manifest")" != "universal" ]; then
        echo "$plugin arch must be universal" >&2
        exit 1
    fi
    if [ "${url##*/}" != "$filename" ]; then
        echo "$plugin filename must match URL basename" >&2
        exit 1
    fi
    case "$url" in
        "$server_repo/releases/download/$release_tag/"*) ;;
        *)
            echo "$plugin URL must come from $server_repo release $release_tag" >&2
            exit 1
            ;;
    esac
    if ! printf '%s\n' "$sha" | grep -Eq '^[0-9a-f]{64}$'; then
        echo "$plugin sha256 must be lowercase 64-char hex" >&2
        exit 1
    fi
    if [ "$size" -le 1048576 ]; then
        echo "$plugin size_bytes is too small for a runtime binary" >&2
        exit 1
    fi

    case "$plugin:$filename" in
        sing-box:sing-box-v*-darwin-universal) ;;
        cool-tunnel-core:cool-tunnel-core-v*)
            if [[ "$filename" == *-universal ]]; then
                echo "cool-tunnel-core filename must follow server tag naming, not legacy -universal naming" >&2
                exit 1
            fi
            ;;
        *)
            echo "$plugin filename has an unexpected shape: $filename" >&2
            exit 1
            ;;
    esac
done

if [ "$(jq -r '.plugins["sing-box"].source.repo' "$manifest")" != "https://github.com/SagerNet/sing-box" ]; then
    echo "sing-box source repo drift" >&2
    exit 1
fi
if [ "$(jq -r '.plugins["sing-box"].source.ref' "$manifest")" != "$(jq -r '.plugins["sing-box"].version' "$manifest")" ]; then
    echo "sing-box source ref must match plugin version" >&2
    exit 1
fi
if [ "$(jq -r '.plugins["cool-tunnel-core"].source.repo' "$manifest")" != "https://github.com/coo1white/cool-tunnel" ]; then
    echo "cool-tunnel-core source repo drift" >&2
    exit 1
fi
if ! jq -e '.plugins["cool-tunnel-core"].source.ref | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")' "$manifest" >/dev/null; then
    echo "cool-tunnel-core source ref must be a release tag" >&2
    exit 1
fi

echo "    client-runtime manifest: clean"
