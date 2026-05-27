// SPDX-License-Identifier: AGPL-3.0-only
// Static guards for deployment/release files that are easy to
// regress without touching TypeScript source.

import { expect, test } from "bun:test";
import { operatorPath, repoPath } from "./test-paths";

test("Dockerfiles consume prebuilt singbox-core instead of compiling on VPS", async () => {
    for (const path of [repoPath("docker/singbox/Dockerfile"), repoPath("docker/admin-api/Dockerfile")]) {
        const body = await Bun.file(path).text();
        expect(body).toContain("ARG CT_SINGBOX_CORE_IMAGE=cool-tunnel-server-singbox-core:latest");
        expect(body).toContain("FROM ${CT_SINGBOX_CORE_IMAGE} AS singbox-core-stage");
        expect(body).toContain("COPY --from=singbox-core-stage /usr/local/bin/singbox-core");
        expect(body).not.toContain("bun build --compile");
    }
});

test("operator release workflow pins Bun instead of floating latest", async () => {
    const body = await Bun.file(repoPath(".github/workflows/operator-release.yml")).text();
    expect(body).toContain("bun-version: 1.3.14");
    expect(body).not.toContain("bun-version: latest");
});

test("release workflows avoid floating Bun and fragile asset merges", async () => {
    const clientRuntime = await Bun.file(repoPath(".github/workflows/client-runtime-release.yml")).text();
    const imageBundle = await Bun.file(repoPath(".github/workflows/release-image-bundle.yml")).text();
    const audit = await Bun.file(repoPath(".github/workflows/audit.yml")).text();

    expect(clientRuntime).toContain("bun-version: 1.3.14");
    expect(clientRuntime).not.toContain("bun-version: latest");
    expect(clientRuntime).toContain("--clobber || true");
    expect(clientRuntime).toContain("cp runtime/SHA256SUMS.runtime runtime/SHA256SUMS");
    expect(imageBundle).toContain("shopt -s nullglob");
    expect(imageBundle).toContain('if [ "${#assets[@]}" -eq 0 ]');
    expect(audit).toContain("ARG CT_CADDY_RUNTIME_IMAGE=");
});

test("monorepo installs use the root pnpm lockfile instead of nested Bun installs", async () => {
    const ci = await Bun.file(repoPath(".github/workflows/ci.yml")).text();
    const audit = await Bun.file(repoPath(".github/workflows/audit.yml")).text();
    const release = await Bun.file(repoPath(".github/workflows/operator-release.yml")).text();
    const makefile = await Bun.file(repoPath("Makefile")).text();
    const singboxRelease = await Bun.file(repoPath("scripts/build_release_singbox_core_assets.sh")).text();
    const adminApiDockerfile = await Bun.file(repoPath("docker/admin-api/Dockerfile")).text();
    const adminWebDockerfile = await Bun.file(repoPath("docker/admin-web/Dockerfile")).text();

    for (const body of [ci, audit, release, makefile]) {
        expect(body).toContain("pnpm install --frozen-lockfile");
        expect(body).not.toContain("bun install --frozen-lockfile");
    }
    for (const body of [adminApiDockerfile, adminWebDockerfile]) {
        expect(body).toContain("npm install -g pnpm@11.1.1");
        expect(body).not.toContain("bun install -g pnpm");
    }
    expect(singboxRelease).toContain("install --frozen-lockfile");
    expect(singboxRelease).not.toContain("bun install --frozen-lockfile");
    expect(release).toContain("version: 11.1.1");
    expect(ci).toContain("version: 11.1.1");
});

test("admin web runtime includes node for next start", async () => {
    const body = await Bun.file(repoPath("docker/admin-web/Dockerfile")).text();

    expect(body).toContain("FROM ${CT_BUN_IMAGE} AS runtime");
    expect(body).toContain("RUN apk add --no-cache nodejs");
    expect(body).toContain('CMD ["bun", "--cwd", "apps/web", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]');
});

test("operator linux x64 release binary uses baseline CPU target", async () => {
    const body = await Bun.file(operatorPath("build.ts")).text();
    expect(body).toContain(`"linux-x64": "bun-linux-x64-baseline"`);
    expect(body).not.toContain("bun-linux-x64-modern");
});

test("release workflow publishes prebuilt core assets with checksums", async () => {
    const body = await Bun.file(repoPath(".github/workflows/operator-release.yml")).text();
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

test("prebuilt core release path wraps release binary as runtime source image", async () => {
    const buildScript = await Bun.file(repoPath("scripts/build_release_core_assets.sh")).text();
    const dockerfile = await Bun.file(repoPath("docker/core/prebuilt.Dockerfile")).text();
    const assetDockerfile = await Bun.file(repoPath("docker/core/release-asset.Dockerfile")).text();
    const install = await Bun.file(operatorPath("install.ts")).text();
    const update = await Bun.file(operatorPath("update.ts")).text();

    expect(dockerfile).toContain("FROM scratch AS runtime");
    expect(dockerfile).toContain("COPY ct-server-core /usr/local/bin/ct-server-core");
    expect(dockerfile).not.toContain("docker/dockerfile:");
    expect(dockerfile).not.toContain("ENTRYPOINT");
    expect(await Bun.file(repoPath("docker/core/Dockerfile")).text()).toContain("CT_RUST_BASE_IMAGE");
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

test("image bundle fetcher explains missing release assets without building locally", async () => {
    const body = await Bun.file(repoPath("scripts/fetch_image_bundle.sh")).text();

    expect(body).toContain("expected one of these checksum entries");
    expect(body).toContain("cool-tunnel-server-images-${OS}-${ARCH}.bom.json");
    expect(body).toContain("cool-tunnel-server-images-${OS}-${ARCH}.tar.gz");
    expect(body).toContain("does not build Docker images locally");
    expect(body).toContain("retrying is safe");
    expect(body).not.toContain("docker build");
});

test("prebuilt singbox-core release path wraps release binary for admin-api and singbox images", async () => {
    const buildScript = await Bun.file(repoPath("scripts/build_release_singbox_core_assets.sh")).text();
    const dockerfile = await Bun.file(repoPath("docker/singbox-core/prebuilt.Dockerfile")).text();
    const compose = await Bun.file(repoPath("docker-compose.yml")).text();
    const install = await Bun.file(operatorPath("install.ts")).text();
    const update = await Bun.file(operatorPath("update.ts")).text();
    const pkg = await Bun.file(repoPath("singbox-core/package.json")).text();
    const version = await Bun.file(repoPath("singbox-core/src/version.ts")).text();

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
    const fetchScript = await Bun.file(repoPath("scripts/fetch_image_bundle.sh")).text();
    const buildScript = await Bun.file(repoPath("scripts/build_release_image_bundle.sh")).text();
    const backup = await Bun.file(operatorPath("backup.ts")).text();
    const install = await Bun.file(operatorPath("install.ts")).text();
    const update = await Bun.file(operatorPath("update.ts")).text();
    const restore = await Bun.file(operatorPath("restore.ts")).text();

    expect(fetchScript).toContain('BOM_TARGET="cool-tunnel-server-images-${OS}-${ARCH}.bom.json"');
    expect(fetchScript).toContain('LEGACY_TARGET="cool-tunnel-server-images-${OS}-${ARCH}.tar.gz"');
    expect(fetchScript).toContain("load_image_bom");
    expect(fetchScript).toContain("load_legacy_bundle");
    expect(fetchScript).toContain("docker load");
    expect(fetchScript).toContain("CT_KEEP_IMAGE_BUNDLE_PARTS");
    expect(fetchScript).toContain("CT_IMAGE_BUNDLE_DIR");
    expect(fetchScript).toContain("CT_IMAGE_BUNDLE_STREAM_TMPDIR");
    expect(fetchScript).toContain("mktemp -d");
    expect(fetchScript).toContain("cool-tunnel-server-caddy:latest");
    expect(fetchScript).toContain("cool-tunnel-server-singbox:latest");
    expect(fetchScript).toContain("cool-tunnel-server-admin-api:latest");
    expect(fetchScript).toContain("cool-tunnel-server-admin-web:latest");
    expect(fetchScript).not.toContain("mariadb:");
    expect(fetchScript).not.toContain("redis:");
    expect(fetchScript).not.toContain("CT_SKIP_IMAGE_BUNDLE_FETCH");
    expect(buildScript).toContain("docker save");
    expect(buildScript).toContain("cool-tunnel-server-images-");
    expect(buildScript).toContain("cool-tunnel-server-image-");
    expect(buildScript).toContain("cool-tunnel-server-image-bom");
    expect(buildScript).toContain("CT_IMAGE_BOM_PART_SIZE_MB");
    expect(buildScript).toContain("DOCKER_DEFAULT_PLATFORM");
    expect(buildScript).toContain("docker compose build caddy singbox admin-api admin-web");
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
    }
    expect(install).toContain("This VPS install path does not compile Docker images locally.");
    expect(update).toContain("This VPS install/update path does not compile Docker images locally.");
    expect(install).toContain("Load prebuilt Docker image bundle");
    expect(update).toContain("Prepare prebuilt Docker image bundle");
    expect(restore).toContain("Load prebuilt Docker image bundle");
    expect(backup).toContain("docker run --pull never");
    expect(restore).toContain("docker run --pull never");
    expect(backup).not.toContain("docker run --rm");
    expect(restore).not.toContain("docker run --rm");
});

test("update force-recreates services after loading same-tag release images", async () => {
    const update = await Bun.file(operatorPath("update.ts")).text();

    expect(update).toContain("--force-recreate");
    expect(update).toContain("--pull never");
    expect(update).toContain("waitForRuntimeReady");
});

test("admin SQLite is a host bind mount shared by operator and API", async () => {
    const compose = await Bun.file(repoPath("docker-compose.yml")).text();
    const envExample = await Bun.file(repoPath(".env.example")).text();
    const config = await Bun.file(repoPath("packages/config/src/index.ts")).text();
    const restore = await Bun.file(operatorPath("restore.ts")).text();

    expect(envExample).toContain("CT_ADMIN_DB_PATH=./data/admin/admin.sqlite");
    expect(config).toContain('return envValue(env, "CT_ADMIN_DB_PATH") || "./data/admin/admin.sqlite"');
    expect(compose).toContain("./data/admin:/data/admin");
    expect(compose).not.toContain("admin_data:");
    expect(restore).toContain("data/admin/admin.sqlite");
    expect(restore).not.toContain("adminVolume");
});

test("install and update avoid y/n prompts during deploy preflights", async () => {
    const install = await Bun.file(operatorPath("install.ts")).text();
    const update = await Bun.file(operatorPath("update.ts")).text();

    for (const body of [install, update]) {
        expect(body).not.toContain("promptYn");
        expect(body).not.toContain("promptChoice");
        expect(body).not.toContain("[y/N]");
        expect(body).not.toContain("[Y/n]");
        expect(body).not.toContain("Continue with this state?");
        expect(body).not.toContain("Wipe Docker volumes?");
    }
    expect(update).toContain("git pull --ff-only failed; continuing with local checkout");
});

test("install path avoids public fixed admin credentials", async () => {
    const install = await Bun.file(operatorPath("install.ts")).text();
    const update = await Bun.file(operatorPath("update.ts")).text();
    const envMigrate = await Bun.file(operatorPath("src/util/env-migrate.ts")).text();
    const envExample = await Bun.file(repoPath(".env.example")).text();
    const readme = await Bun.file(repoPath("README.md")).text();

    expect(install).toContain("ct admin bootstrap");
    expect(install).toContain("migrateAdminDb");
    expect(install).not.toContain("CT_BOOTSTRAP_ADMIN_PASSWORD");
    expect(install).not.toContain("ct:make-admin --bootstrap-default");
    expect(update).not.toContain("generateBootstrapAdminPassword");
    expect(update).not.toContain("ct:make-admin --bootstrap-default");
    expect(envMigrate).not.toContain("bootstrap-admin-password");
    expect(envMigrate).not.toContain("CT_BOOTSTRAP_ADMIN_PASSWORD");
    expect(envExample).not.toContain("CT_BOOTSTRAP_ADMIN_PASSWORD=");
    expect(readme).toContain("ct admin bootstrap");
    expect(readme).not.toContain("password: value of CT_BOOTSTRAP_ADMIN_PASSWORD");

    for (const body of [install, update, envMigrate, envExample, readme]) {
        expect(body).not.toContain("cool-tunnel-server-2026");
    }
});
