# SPDX-License-Identifier: AGPL-3.0-only
#
# Tiny ct-server-core carrier image for release installs.
#
# The panel Dockerfile only needs an image it can COPY
# /usr/local/bin/ct-server-core from. Release installs fetch the
# verified binary asset and build this scratch image locally, avoiding
# a Rust/Cargo compile on low-resource VPS hosts.

FROM scratch AS runtime
COPY ct-server-core /usr/local/bin/ct-server-core
ENTRYPOINT ["/usr/local/bin/ct-server-core"]
CMD ["--help"]
