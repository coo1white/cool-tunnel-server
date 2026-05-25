#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Validate the project-wide plain-text encoding contract.
#
# All tracked Rust, Bun/TypeScript, shell, Docker, config,
# manifest, and documentation files in this repository are UTF-8.
# Pure ASCII is valid UTF-8. This check intentionally validates bytes
# only; higher-level copy/paste traps such as smart quotes remain
# command-specific validation where they are hazardous.

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

fail=0
while IFS= read -r -d '' path; do
    if ! LC_ALL=C.UTF-8 perl -MEncode=decode -0ne 'decode("UTF-8", $_, Encode::FB_CROAK)' "$path" >/dev/null 2>&1; then
        printf 'non-UTF-8 tracked text file: %s\n' "$path" >&2
        fail=1
    fi
done < <(git grep -Ilz -e '' -- .)

exit "$fail"
