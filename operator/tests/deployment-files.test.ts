// SPDX-License-Identifier: AGPL-3.0-only
// Static guards for deployment/release files that are easy to
// regress without touching TypeScript source.

import { expect, test } from "bun:test";

test("Dockerfiles consume prebuilt singbox-core instead of compiling on VPS", async () => {
    for (const path of ["../docker/singbox/Dockerfile", "../docker/panel/Dockerfile"]) {
        const body = await Bun.file(path).text();
        expect(body).toContain("ARG CT_SINGBOX_CORE_IMAGE=cool-tunnel-server-singbox-core:latest");
        expect(body).toContain("FROM ${CT_SINGBOX_CORE_IMAGE} AS singbox-core-stage");
        expect(body).toContain("COPY --from=singbox-core-stage /usr/local/bin/singbox-core");
        expect(body).not.toContain("bun install --frozen-lockfile");
        expect(body).not.toContain("bunx tsc --noEmit");
        expect(body).not.toContain("bun build --compile");
    }
});

test("operator release workflow pins Bun instead of floating latest", async () => {
    const body = await Bun.file("../.github/workflows/operator-release.yml").text();
    expect(body).toContain("bun-version: 1.3.14");
    expect(body).not.toContain("bun-version: latest");
});

test("operator linux x64 release binary uses baseline CPU target", async () => {
    const body = await Bun.file("./build.ts").text();
    expect(body).toContain(`"linux-x64": "bun-linux-x64-baseline"`);
    expect(body).not.toContain("bun-linux-x64-modern");
});

test("release workflow publishes prebuilt core assets with checksums", async () => {
    const body = await Bun.file("../.github/workflows/operator-release.yml").text();
    expect(body).toContain("Build prebuilt ct-server-core assets");
    expect(body).toContain("Build prebuilt singbox-core assets");
    expect(body).toContain("operator/bin/ct-server-core-linux-x64");
    expect(body).toContain("operator/bin/ct-server-core-linux-arm64");
    expect(body).toContain("operator/bin/singbox-core-linux-*");
    expect(body).toContain("sha256sum ct-operator-* ct-server-core-* singbox-core-* > SHA256SUMS");
    expect(body).toContain("operator/bin/ct-server-core-*");
    expect(body).toContain("operator/bin/singbox-core-*");
});

test("prebuilt core fetch path wraps release binary as panel source image", async () => {
    const script = await Bun.file("../scripts/fetch_core_binary.sh").text();
    const buildScript = await Bun.file("../scripts/build_release_core_assets.sh").text();
    const dockerfile = await Bun.file("../docker/core/prebuilt.Dockerfile").text();
    const assetDockerfile = await Bun.file("../docker/core/release-asset.Dockerfile").text();
    const install = await Bun.file("./install.ts").text();
    const update = await Bun.file("./update.ts").text();

    expect(script).toContain('TARGET="ct-server-core-${OS}-${ARCH}"');
    expect(script).toContain('IMAGE="${CT_CORE_IMAGE:-cool-tunnel-server-core:latest}"');
    expect(script).toContain("docker/core/prebuilt.Dockerfile");
    expect(script).toContain("exit 2");
    expect(dockerfile).toContain("FROM scratch AS runtime");
    expect(dockerfile).toContain("COPY ct-server-core /usr/local/bin/ct-server-core");
    expect(dockerfile).not.toContain("docker/dockerfile:");
    expect(await Bun.file("../docker/core/Dockerfile").text()).toContain("CT_RUST_BASE_IMAGE");
    expect(install).toContain("./scripts/fetch_core_binary.sh");
    expect(update).toContain("./scripts/fetch_core_binary.sh");
    expect(buildScript).toContain("docker buildx build");
    expect(buildScript).toContain("docker/core/release-asset.Dockerfile");
    expect(buildScript).toContain("linux/amd64");
    expect(buildScript).toContain("linux/arm64");
    expect(buildScript).toContain("CT_ALPINE_REPOSITORY_BASE");
    expect(buildScript).toContain("SHA256SUMS.core");
    expect(assetDockerfile).toContain("cargo build --release --locked --bin ct-server-core");
    expect(assetDockerfile).not.toContain("cargo chef");
});

test("prebuilt singbox-core fetch path wraps release binary for panel and singbox images", async () => {
    const script = await Bun.file("../scripts/fetch_singbox_core_binary.sh").text();
    const buildScript = await Bun.file("../scripts/build_release_singbox_core_assets.sh").text();
    const dockerfile = await Bun.file("../docker/singbox-core/prebuilt.Dockerfile").text();
    const compose = await Bun.file("../docker-compose.yml").text();
    const install = await Bun.file("./install.ts").text();
    const update = await Bun.file("./update.ts").text();
    const pkg = await Bun.file("../singbox-core/package.json").text();
    const version = await Bun.file("../singbox-core/src/version.ts").text();

    expect(script).toContain('TARGET="singbox-core-${OS}-${ARCH}"');
    expect(script).toContain('IMAGE="${CT_SINGBOX_CORE_IMAGE:-cool-tunnel-server-singbox-core:latest}"');
    expect(script).toContain("docker/singbox-core/prebuilt.Dockerfile");
    expect(script).toContain("exit 2");
    expect(script).not.toContain("CT_SINGBOX_CORE_BUILD_FROM_SOURCE");
    expect(dockerfile).toContain("FROM scratch AS runtime");
    expect(dockerfile).toContain("COPY singbox-core /usr/local/bin/singbox-core");
    expect(dockerfile).not.toContain("docker/dockerfile:");
    expect(compose).toContain("CT_SINGBOX_CORE_IMAGE: cool-tunnel-server-singbox-core:latest");
    expect(install).toContain("./scripts/fetch_singbox_core_binary.sh");
    expect(install).toContain("singbox-core release asset unavailable");
    expect(update).toContain("./scripts/fetch_singbox_core_binary.sh");
    expect(update).toContain("singbox-core release asset unavailable");
    expect(buildScript).toContain("bun-linux-x64-baseline");
    expect(buildScript).toContain("bun-linux-arm64");
    expect(buildScript).toContain("SHA256SUMS.singbox-core");
    expect(pkg).toContain("bun-linux-x64-baseline");
    expect(pkg).toContain("build:linux-arm64");
    expect(version).toContain('platform === "linux" && arch === "arm64"');
});
