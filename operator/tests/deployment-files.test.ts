// SPDX-License-Identifier: AGPL-3.0-only
// Static guards for deployment/release files that are easy to
// regress without touching TypeScript source.

import { expect, test } from "bun:test";

test("Dockerfiles compile singbox-core for the target platform", async () => {
    for (const path of ["../docker/singbox/Dockerfile", "../docker/panel/Dockerfile"]) {
        const body = await Bun.file(path).text();
        expect(body).toContain("ARG TARGETARCH");
        expect(body).toContain("bun-linux-arm64");
        expect(body).toContain("bun-linux-x64");
        expect(body).not.toContain("--target=bun-linux-x64");
        expect(body).not.toContain("bun install --frozen-lockfile 2>/dev/null || bun install");
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

test("release workflow publishes prebuilt ct-server-core assets with checksums", async () => {
    const body = await Bun.file("../.github/workflows/operator-release.yml").text();
    expect(body).toContain("Build prebuilt ct-server-core assets");
    expect(body).toContain("operator/bin/ct-server-core-linux-x64");
    expect(body).toContain("operator/bin/ct-server-core-linux-arm64");
    expect(body).toContain("sha256sum ct-operator-* ct-server-core-* > SHA256SUMS");
    expect(body).toContain("operator/bin/ct-server-core-*");
});

test("prebuilt core fetch path wraps release binary as panel source image", async () => {
    const script = await Bun.file("../scripts/fetch_core_binary.sh").text();
    const buildScript = await Bun.file("../scripts/build_release_core_assets.sh").text();
    const dockerfile = await Bun.file("../docker/core/prebuilt.Dockerfile").text();
    const install = await Bun.file("./install.ts").text();
    const update = await Bun.file("./update.ts").text();

    expect(script).toContain('TARGET="ct-server-core-${OS}-${ARCH}"');
    expect(script).toContain('IMAGE="${CT_CORE_IMAGE:-cool-tunnel-server-core:latest}"');
    expect(script).toContain("docker/core/prebuilt.Dockerfile");
    expect(script).toContain("exit 2");
    expect(dockerfile).toContain("FROM scratch AS runtime");
    expect(dockerfile).toContain("COPY ct-server-core /usr/local/bin/ct-server-core");
    expect(install).toContain("./scripts/fetch_core_binary.sh");
    expect(update).toContain("./scripts/fetch_core_binary.sh");
    expect(buildScript).toContain("docker buildx build");
    expect(buildScript).toContain("linux/amd64");
    expect(buildScript).toContain("linux/arm64");
    expect(buildScript).toContain("SHA256SUMS.core");
});
