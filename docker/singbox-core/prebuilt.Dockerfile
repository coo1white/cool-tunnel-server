# SPDX-License-Identifier: AGPL-3.0-only
#
# Tiny singbox-core carrier image for release installs.
#
# The panel and ct-singbox Dockerfiles only need an image they can COPY
# /usr/local/bin/singbox-core from. Release installs fetch the verified
# binary asset and build this scratch image locally, avoiding Bun,
# TypeScript, and compile work on low-resource VPS hosts.

FROM scratch AS runtime
COPY singbox-core /usr/local/bin/singbox-core
