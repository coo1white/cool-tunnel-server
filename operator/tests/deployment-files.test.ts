// SPDX-License-Identifier: AGPL-3.0-only
// Static guards for deployment/release files that are easy to
// regress without touching TypeScript source.

import { expect, test } from "bun:test";
import { operatorPath, repoPath } from "./test-paths";

test("Dockerfiles consume prebuilt singbox-core instead of compiling on VPS", async () => {
  for (const path of [
    repoPath("docker/singbox/Dockerfile"),
    repoPath("docker/admin-api/Dockerfile"),
  ]) {
    const body = await Bun.file(path).text();
    expect(body).toContain("ARG CT_SINGBOX_CORE_IMAGE=cool-tunnel-server-singbox-core:latest");
    expect(body).toContain("FROM ${CT_SINGBOX_CORE_IMAGE} AS singbox-core-stage");
    expect(body).toContain("COPY --from=singbox-core-stage /usr/local/bin/singbox-core");
    expect(body).not.toContain("bun build --compile");
  }
});

test("Bun/pnpm setup is pinned in the composite action (single source of truth)", async () => {
  // After the workflow cleanup, the Bun + pnpm versions live in the
  // composite action and every consumer uses `./.github/actions/setup-bun-pnpm`.
  const composite = await Bun.file(repoPath(".github/actions/setup-bun-pnpm/action.yml")).text();
  expect(composite).toContain('default: "1.3.14"');
  expect(composite).toContain('default: "11.1.1"');
  expect(composite).not.toContain("bun-version: latest");

  const releaseOperator = await Bun.file(repoPath(".github/workflows/release.yml")).text();
  expect(releaseOperator).toContain("uses: ./.github/actions/setup-bun-pnpm");
  expect(releaseOperator).not.toContain("bun-version: latest");
});

test("release workflows avoid floating Bun and fragile asset merges", async () => {
  const clientRuntime = await Bun.file(repoPath(".github/workflows/release.yml")).text();
  const imageBundle = await Bun.file(repoPath(".github/workflows/release.yml")).text();
  const audit = await Bun.file(repoPath(".github/workflows/audit.yml")).text();

  // The client-runtime job in release.yml is a bun-only consumer (no pnpm),
  // so it pins bun-version directly rather than using the setup-bun-pnpm composite.
  expect(clientRuntime).toContain("bun-version: 1.3.14");
  expect(clientRuntime).not.toContain("bun-version: latest");
  expect(clientRuntime).toContain("--clobber || true");
  expect(clientRuntime).toContain("cp runtime/SHA256SUMS.runtime runtime/SHA256SUMS");
  // The image-bundle upload guards against a missing combined bundle with an
  // explicit existence check rather than a fragile glob array.
  expect(imageBundle).toContain('if [ ! -f "$bundle" ]');
  expect(audit).toContain("ARG CT_CADDY_RUNTIME_IMAGE=");
});

test("monorepo installs use the root pnpm lockfile instead of nested Bun installs", async () => {
  const ci = await Bun.file(repoPath(".github/workflows/ci.yml")).text();
  const audit = await Bun.file(repoPath(".github/workflows/audit.yml")).text();
  const release = await Bun.file(repoPath(".github/workflows/release.yml")).text();
  const composite = await Bun.file(repoPath(".github/actions/setup-bun-pnpm/action.yml")).text();
  const makefile = await Bun.file(repoPath("Makefile")).text();
  const singboxRelease = await Bun.file(
    repoPath("scripts/build_release_singbox_core_assets.sh"),
  ).text();
  const adminApiDockerfile = await Bun.file(repoPath("docker/admin-api/Dockerfile")).text();
  const adminWebDockerfile = await Bun.file(repoPath("docker/admin-web/Dockerfile")).text();

  // The composite action runs `pnpm install --frozen-lockfile` for the four
  // ci/audit consumers (release.yml's operator job opts out and runs it
  // in its own multi-step run block). So the literal command lives in the
  // composite + release.yml + Makefile, and ci/audit reference the
  // composite via `uses:`.
  expect(composite).toContain("pnpm install --frozen-lockfile");
  for (const body of [release, makefile]) {
    expect(body).toContain("pnpm install --frozen-lockfile");
  }
  for (const body of [ci, audit, release]) {
    expect(body).toContain("uses: ./.github/actions/setup-bun-pnpm");
    expect(body).not.toContain("bun install --frozen-lockfile");
  }
  for (const body of [adminApiDockerfile, adminWebDockerfile]) {
    expect(body).toContain("npm install -g pnpm@11.1.1");
    expect(body).not.toContain("bun install -g pnpm");
  }
  expect(singboxRelease).toContain("install --frozen-lockfile");
  expect(singboxRelease).not.toContain("bun install --frozen-lockfile");
});

test("admin web runtime includes node for next start", async () => {
  const body = await Bun.file(repoPath("docker/admin-web/Dockerfile")).text();

  expect(body).toContain("FROM ${CT_BUN_IMAGE} AS runtime");
  expect(body).toContain("RUN apk add --no-cache nodejs");
  expect(body).toContain(
    'CMD ["bun", "run", "--cwd", "apps/web", "start", "--", "-H", "0.0.0.0", "-p", "3000"]',
  );
});

test("operator linux x64 release binary uses baseline CPU target", async () => {
  const body = await Bun.file(operatorPath("build.ts")).text();
  expect(body).toContain(`"linux-x64": "bun-linux-x64-baseline"`);
  expect(body).not.toContain("bun-linux-x64-modern");
});

test("release workflow publishes prebuilt singbox-core assets with checksums", async () => {
  const body = await Bun.file(repoPath(".github/workflows/release.yml")).text();
  expect(body).toContain("Build prebuilt singbox-core assets");
  expect(body).toContain("operator/bin/singbox-core-linux-*");
  expect(body).toContain("sha256sum ct-operator-* > SHA256SUMS.generated");
  expect(body).toContain("sha256sum singbox-core-* >> SHA256SUMS.generated");
  expect(body).toContain("operator/bin/singbox-core-*");
  // The retired Rust server daemon must not reappear in the release path;
  // ct-protocol is consumed by clients as a source crate, not a binary asset.
  expect(body).not.toContain("ct-server-core");
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
  const buildScript = await Bun.file(
    repoPath("scripts/build_release_singbox_core_assets.sh"),
  ).text();
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
  for (const _body of [install, update]) {
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

test("update wires the legacy .env auto-migration step", async () => {
  const update = await Bun.file(operatorPath("update.ts")).text();
  expect(update).toContain('from "./src/util/env-migrate"');
  expect(update).toContain("migrateEnv(");
  expect(update).toContain("Auto-migrate legacy .env");
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
  expect(config).toContain(
    'return envValue(env, "CT_ADMIN_DB_PATH") || "./data/admin/admin.sqlite"',
  );
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

test("backup bundles repo-root files via an absolute -C, not a fragile relative ..", async () => {
  const backup = await Bun.file(operatorPath("backup.ts")).text();

  // tmpDir is `tmp/backup-XXXXXX` (two levels deep), so a relative
  // `-C ..` lands in `tmp/`, not the repo root, and tar dies with
  // "package.json: Cannot stat: No such file or directory".
  expect(backup).toContain("const repoRoot = process.cwd();");
  expect(backup).toContain(
    "-C ${repoRoot} .env manifests caddy/Caddyfile.tpl package.json pnpm-lock.yaml",
  );
  expect(backup).not.toContain("-C .. .env");
});

test("admin-web image bakes CT_API_INTERNAL_ORIGIN at build time for next rewrites", async () => {
  const dockerfile = await Bun.file(repoPath("docker/admin-web/Dockerfile")).text();
  const nextConfig = await Bun.file(repoPath("apps/web/next.config.mjs")).text();

  // next rewrites() are frozen into routes-manifest.json at build time,
  // so the in-cluster API origin must be set BEFORE `pnpm ... build`,
  // not just at runtime — otherwise /up and /api/* proxy to the dev
  // fallback 127.0.0.1:9000 and ECONNREFUSED inside the container.
  const buildIdx = dockerfile.indexOf("@cool-tunnel/web build");
  const envIdx = dockerfile.indexOf("ENV CT_API_INTERNAL_ORIGIN=");
  expect(envIdx).toBeGreaterThan(-1);
  expect(buildIdx).toBeGreaterThan(-1);
  expect(envIdx).toBeLessThan(buildIdx);
  expect(dockerfile).toContain("ARG CT_API_INTERNAL_ORIGIN=http://admin-api:9000");
  expect(nextConfig).toContain("process.env.CT_API_INTERNAL_ORIGIN");
});

test("admin task imports workspace packages with literal specifiers so they bundle into the compiled binary", async () => {
  const admin = await Bun.file(operatorPath("src/tasks/admin.ts")).text();

  // `bun build --compile` only bundles dynamic imports whose specifier is a
  // static string literal. A computed specifier like
  // import(`@cool-tunnel/${name}`) is invisible to the bundler, so the
  // packages are absent from the binary and every `ct admin` subcommand dies
  // with `Cannot find module '@cool-tunnel/config' from '/$bunfs/root/...'`.
  expect(admin).toContain('import("@cool-tunnel/config")');
  expect(admin).toContain('import("@cool-tunnel/db")');
  expect(admin).toContain('import("@cool-tunnel/security")');
  expect(admin).not.toMatch(/import\(`@cool-tunnel\//);
  expect(admin).not.toContain("packageName(");
});

test("release publishes one combined image bundle per platform by default", async () => {
  const buildScript = await Bun.file(repoPath("scripts/build_release_image_bundle.sh")).text();
  const workflow = await Bun.file(repoPath(".github/workflows/release.yml")).text();

  // Default output is a single cool-tunnel-server-images-<suffix>.tar.gz per
  // platform; the per-image streaming BOM is opt-in for tiny-disk hosts. The
  // retired CT_BUILD_FULL_IMAGE_BUNDLE flag must not linger.
  expect(buildScript).toContain("write_full_bundle");
  expect(buildScript).toContain('CT_BUILD_IMAGE_BOM="${CT_BUILD_IMAGE_BOM:-0}"');
  expect(buildScript).not.toContain("CT_BUILD_FULL_IMAGE_BUNDLE");

  // The workflow uploads the combined bundle, not per-image parts/BOM.
  expect(workflow).toContain("release-assets/cool-tunnel-server-images-${suffix}.tar.gz");
  expect(workflow).not.toContain("cool-tunnel-server-image-${suffix}-*.tar.gz.part-*");
  expect(workflow).not.toContain("cool-tunnel-server-images-${suffix}.bom.json");

  // The fetch path still understands both layouts (backward compatible).
  const fetchScript = await Bun.file(repoPath("scripts/fetch_image_bundle.sh")).text();
  expect(fetchScript).toContain("load_legacy_bundle");
});

test("admin password input prompts interactively (hidden) on a TTY", async () => {
  const admin = await Bun.file(operatorPath("src/tasks/admin.ts")).text();

  // create-owner / reset-password prompt for the password with hidden
  // input + confirmation when run in a terminal, instead of silently
  // blocking on --password-stdin.
  expect(admin).toContain("process.stdin.isTTY");
  expect(admin).toContain("setRawMode(true)");
  expect(admin).toContain("Confirm password:");

  // Raw mode (echo off) MUST be enabled before the prompt label is
  // written, or input typed immediately would be echoed to the screen.
  const rawIdx = admin.indexOf("stdin.setRawMode(true)");
  const labelIdx = admin.indexOf("process.stderr.write(label)");
  expect(rawIdx).toBeGreaterThan(-1);
  expect(labelIdx).toBeGreaterThan(rawIdx);
});

test("image-bundle fetch waits for a still-publishing release instead of failing", async () => {
  const fetchScript = await Bun.file(repoPath("scripts/fetch_image_bundle.sh")).text();

  // A tag publishes the operator binary first and the image bundle minutes
  // later; the fetch must poll for the bundle rather than exit immediately,
  // so `ct update`/`ct install` run right after a release don't fail.
  expect(fetchScript).toContain("CT_IMAGE_BUNDLE_WAIT_SECS");
  expect(fetchScript).toContain("WAIT_INTERVAL");
  expect(fetchScript).toContain("bundle_deadline");
  expect(fetchScript).toContain('sleep "$WAIT_INTERVAL"');
  // fail-fast remains available for CI/automation
  expect(fetchScript).toContain("CT_IMAGE_BUNDLE_WAIT_SECS=0");
  // the existing dual-format support must remain intact
  expect(fetchScript).toContain("load_legacy_bundle");
  expect(fetchScript).toContain("load_image_bom");
});

test("proxy/user actions pass the command explicitly, never via a shared submit button", async () => {
  const proxyTable = await Bun.file(repoPath("apps/web/src/proxy-accounts.tsx")).text();
  const userActions = await Bun.file(repoPath("apps/web/src/user-actions.tsx")).text();
  const editPage = await Bun.file(repoPath("apps/web/app/users/[id]/page.tsx")).text();

  // A clicked submit button's name/value is dropped under React 19
  // useActionState when buttons share one form (the empty-command 404).
  // Both proxy and user commands are now invoked imperatively with an
  // explicit command string from a client component.
  expect(proxyTable).toContain("proxyCommand(account.id,");
  expect(userActions).toContain("userCommand(userId,");
  expect(editPage).toContain("<UserActions");
  for (const page of [proxyTable, userActions, editPage]) {
    expect(page).not.toMatch(/<button[^>]*name="command"/);
  }
});

test("subscription reveal is permission-gated, redacted, and audited", async () => {
  const app = await Bun.file(repoPath("apps/api/src/app.ts")).text();
  const store = await Bun.file(repoPath("packages/db/src/store.ts")).text();

  // The subscription token is masked by default; revealing the full URL must
  // require write permission, pass through redactProxyAccountFor (owner/admin
  // only), and record an audit event.
  expect(app).toContain('app.post("/api/proxy-accounts/:id/reveal"');
  expect(app).toMatch(
    /proxy-accounts\/:id\/reveal".*requirePermission\("proxy-accounts:write"\).*redactProxyAccountFor/s,
  );
  expect(store).toContain("revealProxySubscription");
  expect(store).toContain('"proxy_account.subscription_revealed"');
});

test("network preflight probe retries transient failures", async () => {
  const preflight = await Bun.file(repoPath("operator/src/util/preflight.ts")).text();

  // A momentary blip on a flaky/throttled link must not abort install/update;
  // the reachability probe retries before declaring a host unreachable.
  expect(preflight).toContain("--retry");
  expect(preflight).toContain("--retry-connrefused");
});

test("release stays a draft until every BOM asset is present, then publishes + marks latest", async () => {
  const release = await Bun.file(repoPath(".github/workflows/release.yml")).text();
  const bom = JSON.parse(await Bun.file(repoPath("manifests/release-assets.json")).text()) as {
    assets: string[];
  };

  // The release is created as a draft (hidden); a finalize job verifies the
  // full release BOM, then un-drafts (publishes) + marks latest — so an
  // incomplete release (any failed asset job) is never publicly visible.
  expect(release).toContain("--verify-tag --draft");
  expect(release).toContain("finalize:");
  expect(release).toContain("jq -r '.assets[]' manifests/release-assets.json");
  // finalize publishes (un-draft) + marks latest, gated on the BOM check.
  const finalizeIdx = release.indexOf("finalize:");
  expect(release.indexOf("--draft=false", finalizeIdx)).toBeGreaterThan(finalizeIdx);
  expect(release.indexOf("--latest", finalizeIdx)).toBeGreaterThan(finalizeIdx);

  // The BOM lists every expected platform/asset, so a partial release is caught.
  for (const a of [
    "SHA256SUMS",
    "ct-operator-linux-x64",
    "ct-operator-linux-arm64",
    "ct-operator-darwin-arm64",
    "singbox-core-linux-x64",
    "singbox-core-linux-arm64",
    "cool-tunnel-server-images-linux-x64.tar.gz",
    "cool-tunnel-server-images-linux-arm64.tar.gz",
    "cool-tunnel-core-v*",
    "sing-box-v*-darwin-universal",
  ]) {
    expect(bom.assets).toContain(a);
  }
});
