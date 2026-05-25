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
    expect(body).toContain("sha256sum ct-operator-* > SHA256SUMS.generated");
    expect(body).toContain('github.event.inputs.scope != \'operator-only\'');
    expect(body).toContain("sha256sum ct-server-core-* singbox-core-* >> SHA256SUMS.generated");
    expect(body).toContain("operator/bin/ct-server-core-*");
    expect(body).toContain("operator/bin/singbox-core-*");
});

test("prebuilt core release path wraps release binary as panel source image", async () => {
    const buildScript = await Bun.file("../scripts/build_release_core_assets.sh").text();
    const dockerfile = await Bun.file("../docker/core/prebuilt.Dockerfile").text();
    const assetDockerfile = await Bun.file("../docker/core/release-asset.Dockerfile").text();
    const install = await Bun.file("./install.ts").text();
    const update = await Bun.file("./update.ts").text();

    expect(dockerfile).toContain("FROM scratch AS runtime");
    expect(dockerfile).toContain("COPY ct-server-core /usr/local/bin/ct-server-core");
    expect(dockerfile).not.toContain("docker/dockerfile:");
    expect(dockerfile).not.toContain("ENTRYPOINT");
    expect(await Bun.file("../docker/core/Dockerfile").text()).toContain("CT_RUST_BASE_IMAGE");
    expect(install).not.toContain("./scripts/fetch_core_binary.sh");
    expect(update).not.toContain("./scripts/fetch_core_binary.sh");
    expect(buildScript).toContain("docker buildx build");
    expect(buildScript).toContain("docker/core/release-asset.Dockerfile");
    expect(buildScript).toContain("linux/amd64");
    expect(buildScript).toContain("linux/arm64");
    expect(buildScript).toContain("CT_ALPINE_REPOSITORY_BASE");
    expect(buildScript).toContain("SHA256SUMS.core");
    expect(assetDockerfile).toContain("cargo build --release --locked --bin ct-server-core");
    expect(assetDockerfile).not.toContain("cargo chef");
});

test("prebuilt singbox-core release path wraps release binary for panel and singbox images", async () => {
    const buildScript = await Bun.file("../scripts/build_release_singbox_core_assets.sh").text();
    const dockerfile = await Bun.file("../docker/singbox-core/prebuilt.Dockerfile").text();
    const compose = await Bun.file("../docker-compose.yml").text();
    const install = await Bun.file("./install.ts").text();
    const update = await Bun.file("./update.ts").text();
    const pkg = await Bun.file("../singbox-core/package.json").text();
    const version = await Bun.file("../singbox-core/src/version.ts").text();

    expect(dockerfile).toContain("FROM scratch AS runtime");
    expect(dockerfile).toContain("COPY singbox-core /usr/local/bin/singbox-core");
    expect(dockerfile).not.toContain("docker/dockerfile:");
    expect(dockerfile).not.toContain("ENTRYPOINT");
    expect(compose).toContain("CT_SINGBOX_CORE_IMAGE: cool-tunnel-server-singbox-core:latest");
    expect(install).not.toContain("./scripts/fetch_singbox_core_binary.sh");
    expect(install).not.toContain("singbox-core release asset unavailable");
    expect(update).not.toContain("./scripts/fetch_singbox_core_binary.sh");
    expect(update).not.toContain("singbox-core release asset unavailable");
    expect(buildScript).toContain("bun-linux-x64-musl-baseline");
    expect(buildScript).toContain("bun-linux-arm64-musl");
    expect(buildScript).toContain("SHA256SUMS.singbox-core");
    expect(pkg).toContain("bun-linux-x64-musl-baseline");
    expect(pkg).toContain("bun-linux-arm64-musl");
    expect(pkg).toContain("build:linux-arm64");
    expect(version).toContain('platform === "linux" && arch === "arm64"');
});

test("install and update require prebuilt Docker image bundles instead of VPS builds", async () => {
    const fetchScript = await Bun.file("../scripts/fetch_image_bundle.sh").text();
    const operatorFetchScript = await Bun.file("../scripts/fetch_operator_binary.sh").text();
    const buildScript = await Bun.file("../scripts/build_release_image_bundle.sh").text();
    const backup = await Bun.file("./backup.ts").text();
    const install = await Bun.file("./install.ts").text();
    const update = await Bun.file("./update.ts").text();
    const restore = await Bun.file("./restore.ts").text();

    expect(fetchScript).toContain('BOM_TARGET="cool-tunnel-server-images-${OS}-${ARCH}.bom.json"');
    expect(fetchScript).toContain('LEGACY_TARGET="cool-tunnel-server-images-${OS}-${ARCH}.tar.gz"');
    expect(fetchScript).toContain("load_image_bom");
    expect(fetchScript).toContain("load_legacy_bundle");
    expect(fetchScript).toContain("docker load");
    expect(fetchScript).toContain("next_step");
    expect(fetchScript).toContain("check network/DNS and free disk space");
    expect(fetchScript).toContain("run docker system df");
    expect(fetchScript).toContain("CT_KEEP_IMAGE_BUNDLE_PARTS");
    expect(fetchScript).toContain("CT_IMAGE_BUNDLE_DIR");
    expect(fetchScript).toContain("CT_IMAGE_BUNDLE_STREAM_TMPDIR");
    expect(fetchScript).toContain("mktemp -d");
    expect(fetchScript).toContain("cool-tunnel-server-caddy:latest");
    expect(fetchScript).toContain("cool-tunnel-server-singbox:latest");
    expect(fetchScript).toContain("cool-tunnel-server-panel:latest");
    expect(fetchScript).toContain("mariadb:11.8.6");
    expect(fetchScript).toContain("redis:7.4.8-alpine");
    expect(fetchScript).not.toContain("CT_SKIP_IMAGE_BUNDLE_FETCH");
    expect(operatorFetchScript).toContain("next_step");
    expect(operatorFetchScript).toContain("check network/DNS from this host");
    expect(operatorFetchScript).toContain("GitHub artifact attestation verification failed");
    expect(buildScript).toContain("docker save");
    expect(buildScript).toContain("cool-tunnel-server-images-");
    expect(buildScript).toContain("cool-tunnel-server-image-");
    expect(buildScript).toContain("cool-tunnel-server-image-bom");
    expect(buildScript).toContain("CT_IMAGE_BOM_PART_SIZE_MB");
    expect(buildScript).toContain("DOCKER_DEFAULT_PLATFORM");
    expect(buildScript).toContain("docker compose build caddy singbox panel");
    expect(buildScript).toContain("SHA256SUMS.images");

    for (const body of [install, update, restore]) {
        expect(body).toContain("./scripts/fetch_image_bundle.sh");
        expect(body).toContain("prebuilt Docker image bundle");
        expect(body).toContain("--no-build");
        expect(body).toContain("--pull never");
        expect(body).not.toContain("fetch_core_binary.sh");
        expect(body).not.toContain("fetch_singbox_core_binary.sh");
        expect(body).not.toContain("docker compose build");
    }
    for (const body of [install, update]) {
        expect(body).toContain("This VPS install/update path does not compile Docker images locally.");
    }
    expect(install).toContain("Load image bundle");
    expect(update).toContain("Prepare prebuilt Docker image bundle");
    expect(restore).toContain("Load prebuilt Docker image bundle");
    expect(backup).toContain("docker run --pull never");
    expect(restore).toContain("docker run --pull never");
    expect(backup).not.toContain("docker run --rm");
    expect(restore).not.toContain("docker run --rm");
});

test("install and update avoid y/n prompts during deploy preflights", async () => {
    const install = await Bun.file("./install.ts").text();
    const update = await Bun.file("./update.ts").text();

    for (const body of [install, update]) {
        expect(body).not.toContain("promptYn");
        expect(body).not.toContain("promptChoice");
        expect(body).not.toContain("[y/N]");
        expect(body).not.toContain("[Y/n]");
        expect(body).not.toContain("Continue with this state?");
        expect(body).not.toContain("Wipe Docker volumes?");
    }

    expect(install).toContain("existing Docker state preserved");
    expect(install).toContain("reset to origin/main; previous HEAD saved as");
    expect(update).toContain("auto-stashing local edits before update");
    expect(update).toContain("reset to origin/main; previous HEAD saved as");
});

test("bootstrap unexpected failures print next steps without leaking secrets", async () => {
    const body = await Bun.file("../scripts/bootstrap.sh").text();

    expect(body).toContain("bootstrap_failure_hint");
    expect(body).toContain("safe_last_command");
    expect(body).toContain("secret-bearing command hidden");
    expect(body).toContain("trap 'code=$?; bootstrap_failure_hint");
    expect(body).toContain("diagnostics after clone: cd %s && ct doctor");
    expect(body).toContain("git ls-remote %s %s");
    expect(body).toContain("systemctl status docker --no-pager");
});

test("panel entrypoint runs Bun admin migrations and renders", async () => {
    const body = await Bun.file("../docker/panel/entrypoint.sh").text();

    expect(body).toContain("BETTER_AUTH_SECRET");
    expect(body).toContain("admin migrate");
    expect(body).toContain("render caddyfile");
    expect(body).toContain("render singbox");
    expect(body).not.toContain("php artisan");
});

test("Caddy panel proxy sets the only trusted Better Auth client IP header", async () => {
    const caddy = await Bun.file("../caddy/Caddyfile.tpl").text();
    const auth = await Bun.file("./src/admin/auth.ts").text();
    const compose = await Bun.file("../docker-compose.yml").text();

    expect(caddy).toContain("header_up X-Forwarded-For {remote_host}");
    expect(auth).toContain('ipAddressHeaders: ["x-forwarded-for"]');
    expect(auth).not.toContain("cf-connecting-ip");
    expect(auth).not.toContain("x-real-ip");
    expect(compose).toContain("127.0.0.1:9000:9000");
    expect(compose).toContain("proxy-header");
});

test("top-level ct exposes admin and Caddy redirects do not preserve query secrets", async () => {
    const wrapper = await Bun.file("../ct").text();
    const caddy = await Bun.file("../caddy/Caddyfile.tpl").text();

    expect(wrapper).toContain("admin)        dispatch_via_operator admin");
    expect(caddy).toContain("redir https://{host}{path} 308");
    expect(caddy).not.toContain("redir https://{host}{uri} 308");
});

test("install path uses Better Auth first-owner token, not a default password", async () => {
    const install = await Bun.file("./install.ts").text();
    const update = await Bun.file("./update.ts").text();
    const envMigrate = await Bun.file("./src/util/env-migrate.ts").text();
    const panelEntrypoint = await Bun.file("../docker/panel/entrypoint.sh").text();
    const envExample = await Bun.file("../.env.example").text();
    const readme = await Bun.file("../README.md").text();

    expect(install).toContain("ct admin bootstrap");
    expect(update).toContain("generateAdminAuthSecret");
    expect(envMigrate).toContain("better-auth-secret");
    expect(panelEntrypoint).toContain("BETTER_AUTH_SECRET");
    expect(envExample).toContain("BETTER_AUTH_SECRET=");
    expect(readme).toContain("ct admin bootstrap");

    for (const body of [install, update, envMigrate, panelEntrypoint, envExample, readme]) {
        expect(body).not.toContain("cool-tunnel-server-2026");
        expect(body).not.toContain("CT_BOOTSTRAP_ADMIN_PASSWORD");
        expect(body).not.toContain("ct:make-admin");
    }
});
