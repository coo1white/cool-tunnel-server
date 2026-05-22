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
