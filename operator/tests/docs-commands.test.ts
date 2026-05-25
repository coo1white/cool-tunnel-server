// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/docs-commands.test.ts — user-facing command drift checks.

import { test, expect } from "bun:test";
import { repoPath } from "./test-paths";

const LATEST_RELEASE_LINE =
    `LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"`;
const BREW_STYLE_BOOTSTRAP =
    `BRANCH="\${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/\${LATEST}/scripts/bootstrap.sh")"`;
const PIPE_TO_BASH_BOOTSTRAP =
    "curl -fsSL https://raw.githubusercontent.com/coo1white/cool-tunnel-server/main/scripts/bootstrap.sh | bash";

test("quickstart docs use the release-pinned Homebrew-style bootstrap command", async () => {
    for (const path of ["README.md", "GETTING_STARTED.md", "docs/test-vps.md"]) {
        const text = await Bun.file(repoPath(path)).text();
        expect(text).toContain(LATEST_RELEASE_LINE);
        expect(text).toContain(BREW_STYLE_BOOTSTRAP);
        expect(text).not.toContain(PIPE_TO_BASH_BOOTSTRAP);
    }
});

test("bootstrap script advertises and explains the Homebrew-style flow", async () => {
    const text = await Bun.file(repoPath("scripts/bootstrap.sh")).text();
    expect(text).toContain(LATEST_RELEASE_LINE);
    expect(text).toContain(BREW_STYLE_BOOTSTRAP);
    expect(text).toContain("cool-tunnel-server bootstrap will:");
    expect(text).toContain("Press RETURN/ENTER to continue");
    expect(text).toContain("installed /usr/local/bin/ct ->");
    expect(text).toContain("/usr/local/bin/ct exists and is not a symlink");
});

test("core Dockerfile uses the baked Rust toolchain without network rustup sync", async () => {
    const toolchain = await Bun.file(repoPath("core/rust-toolchain.toml")).text();
    const dockerfile = await Bun.file(repoPath("docker/core/Dockerfile")).text();
    const channel = toolchain.match(/^channel\s*=\s*"([^"]+)"/m)?.[1];

    expect(channel).toBeTruthy();
    expect(dockerfile).toContain(`ARG CT_RUST_BASE_IMAGE=rust:${channel}-alpine`);
    expect(dockerfile).toContain("FROM ${CT_RUST_BASE_IMAGE} AS chef");
    expect(dockerfile).toContain("FROM ${CT_RUST_BASE_IMAGE} AS sqlx-prepare");
    expect(dockerfile).toContain(`ENV RUSTUP_TOOLCHAIN=${channel}`);
    expect(dockerfile).toContain(`rustup target list --installed | grep -qx "\${RUST_TARGET}"`);
    expect(dockerfile).not.toContain(`rustup target add "\${RUST_TARGET}" &&`);
    expect(dockerfile).toContain(`rustup component list --installed | grep -qx "\${component}"`);
});

test("README current release badge and text match root package version", async () => {
    const readme = await Bun.file(repoPath("README.md")).text();
    const rootPackage = await Bun.file(repoPath("package.json")).json() as { version?: string };
    const version = rootPackage.version;

    expect(version).toBeTruthy();
    expect(readme).toContain(`release-v${version}-1c5cdc`);
    expect(readme).toContain(`releases/tag/v${version}`);
    expect(readme).toContain(`Latest stable server release: \`v${version}\`.`);
});

test("account admin docs use the Bun operator command surface", async () => {
    const ct = await Bun.file(repoPath("ct")).text();
    expect(ct).toContain("dispatch_via_operator admin");
    for (const path of ["README.md", "GETTING_STARTED.md", "docs/installation-debian.md", "operator/README.md"]) {
        const text = await Bun.file(repoPath(path)).text();
        expect(text).toContain("ct admin bootstrap");
    }
    const readme = await Bun.file(repoPath("README.md")).text();
    const gettingStarted = await Bun.file(repoPath("GETTING_STARTED.md")).text();
    expect(readme).not.toContain("CT_BOOTSTRAP_ADMIN_PASSWORD in /opt/cool-tunnel-server/.env");
    expect(gettingStarted).not.toContain("php artisan ct:make-admin");
});
