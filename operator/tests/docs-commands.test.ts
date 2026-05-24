// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/docs-commands.test.ts — user-facing command drift checks.

import { test, expect } from "bun:test";

const LATEST_RELEASE_LINE =
    `LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/coo1white/cool-tunnel-server/releases/latest | sed 's#.*/##')"`;
const BREW_STYLE_BOOTSTRAP =
    `BRANCH="\${LATEST}" /bin/bash -c "$(curl -fsSL "https://raw.githubusercontent.com/coo1white/cool-tunnel-server/\${LATEST}/scripts/bootstrap.sh")"`;
const PIPE_TO_BASH_BOOTSTRAP =
    "curl -fsSL https://raw.githubusercontent.com/coo1white/cool-tunnel-server/main/scripts/bootstrap.sh | bash";

test("quickstart docs use the release-pinned Homebrew-style bootstrap command", async () => {
    for (const path of ["README.md", "GETTING_STARTED.md", "docs/test-vps.md"]) {
        const text = await Bun.file(`../${path}`).text();
        expect(text).toContain(LATEST_RELEASE_LINE);
        expect(text).toContain(BREW_STYLE_BOOTSTRAP);
        expect(text).not.toContain(PIPE_TO_BASH_BOOTSTRAP);
    }
});

test("bootstrap script advertises and explains the Homebrew-style flow", async () => {
    const text = await Bun.file("../scripts/bootstrap.sh").text();
    expect(text).toContain(LATEST_RELEASE_LINE);
    expect(text).toContain(BREW_STYLE_BOOTSTRAP);
    expect(text).toContain("cool-tunnel-server bootstrap will:");
    expect(text).toContain("Press RETURN/ENTER to continue");
    expect(text).toContain("installed /usr/local/bin/ct ->");
    expect(text).toContain("/usr/local/bin/ct exists and is not a symlink");
});

test("core Dockerfile uses the baked Rust toolchain without network rustup sync", async () => {
    const toolchain = await Bun.file("../core/rust-toolchain.toml").text();
    const dockerfile = await Bun.file("../docker/core/Dockerfile").text();
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

test("README current release badge and text match the panel version", async () => {
    const readme = await Bun.file("../README.md").text();
    const pkg = await Bun.file("./package.json").json() as { version: string };
    const version = pkg.version;

    expect(version).toBeTruthy();
    expect(readme).toContain(`release-v${version}-1c5cdc`);
    expect(readme).toContain(`releases/tag/v${version}`);
    expect(readme).toContain(`Latest stable server release: \`v${version}\`.`);
});

test("root docs no longer describe the retired PHP admin stack", async () => {
    const paths = [
        "STRUCTURE.md",
        "RELEASE.md",
        "VERSIONING.md",
        "SECURITY.md",
        "SUPPORT.md",
        "docs/release-stress-test.md",
        ".gitignore",
        ".dockerignore",
        "renovate.json",
        "operator/help.ts",
    ];
    const forbidden = /Laravel|Filament|FrankenPHP|php artisan|composer|panel\/config\/cool-tunnel\.php|ct:version|one-time admin password|stress:provision/;
    for (const path of paths) {
        const text = await Bun.file(`../${path}`).text();
        expect(text, path).not.toMatch(forbidden);
    }
});
