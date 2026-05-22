#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/pin-images.ts — resolve docker base-image tags to digests + rewrite Dockerfile FROM lines.
//
// Resolve docker base-image tags to digests and rewrite the FROM
// lines in docker/*/Dockerfile in place. LTSC reproducibility — the
// tag `caddy:2.11.3-alpine` can drift if Docker Hub republishes the
// tag, but `caddy:2.11.3-alpine@sha256:...` cannot.
//
// Run on a host where docker can pull. Idempotent — safe to commit
// the result.
//
// Wired into `make pin-images`.

import { $ } from "bun";
import { die, makeTerm } from "./src/util/term";
import { ensureRepoRoot } from "./src/util/repo-root";

const { step, ok, warn } = makeTerm();

// Map of Dockerfile path → image specs to pin. The bash original
// kept these as `path|image` strings to dodge `declare -A`'s
// bash-4-only requirement; here we use a normal object literal.
//
// Round-18 dep-hygiene note (preserved from the bash original):
// the previous version had stale mappings (rust:1.86, php:8.3-fpm)
// that silently no-op'd against renamed FROM lines. The fail-loud
// guard in pin() catches that now.
const MAPPINGS: ReadonlyArray<{ readonly file: string; readonly image: string }> = [
    { file: "docker/caddy/Dockerfile", image: "caddy:2.11.3-builder" },
    { file: "docker/caddy/Dockerfile", image: "caddy:2.11.3-alpine" },
    { file: "docker/singbox/Dockerfile", image: "alpine:3.21" },
    { file: "docker/core/Dockerfile", image: "rust:1.88.0-alpine" },
    { file: "docker/core/Dockerfile", image: "alpine:3.20" },
    { file: "docker/panel/Dockerfile", image: "dunglas/frankenphp:1-php8.4-alpine" },
];

// Build the FROM-line regex for a given image. Matches:
//   FROM <image>[@sha256:<hex>][ <trailer>]
// where <trailer> can be a stage alias (`AS xyz`) or nothing.
//
// Exported for unit tests.
export function fromLineRe(image: string): RegExp {
    const escaped = image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^(FROM\\s+)${escaped}(?:@sha256:[a-f0-9]+)?(\\s|$)`);
}

// Pure rewriter: takes a Dockerfile body, an image, and a digest;
// returns the rewritten body and whether any line was changed. No I/O.
export function rewriteDockerfile(
    body: string,
    image: string,
    digest: string,
): { content: string; changedLines: number } {
    const re = fromLineRe(image);
    let changedLines = 0;
    const out = body.split("\n").map((line) => {
        const m = re.exec(line);
        if (!m) return line;
        changedLines++;
        return `${m[1]}${image}@${digest}${m[2]}${line.slice(m[0].length)}`;
    });
    return { content: out.join("\n"), changedLines };
}

// Best-effort digest resolution. Tries `docker buildx imagetools
// inspect` first, then `docker manifest inspect`. Returns the
// `sha256:<hex>` digest or null if both probes failed.
async function resolveDigest(image: string): Promise<string | null> {
    const buildx = await $`docker buildx imagetools inspect ${image} --format ${"{{json .Manifest}}"}`
        .nothrow()
        .quiet();
    if (buildx.exitCode === 0) {
        try {
            const m = JSON.parse(buildx.stdout.toString());
            if (typeof m.digest === "string" && m.digest.length > 0) return m.digest;
        } catch {
            // fall through
        }
    }
    const manifest = await $`docker manifest inspect ${image}`.nothrow().quiet();
    if (manifest.exitCode === 0) {
        try {
            const m = JSON.parse(manifest.stdout.toString());
            if (typeof m.manifests?.[0]?.digest === "string") return m.manifests[0].digest;
            if (typeof m.config?.digest === "string") return m.config.digest;
        } catch {
            // fall through
        }
    }
    return null;
}

async function pin(file: string, image: string): Promise<void> {
    const f = Bun.file(file);
    if (!(await f.exists())) {
        die(`pin-images: ${file} not found`,
            "check the mappings list in operator/pin-images.ts");
    }
    const original = await f.text();
    const re = fromLineRe(image);
    if (!original.split("\n").some((l) => re.test(l))) {
        die(
            `pin-images mapping out of date: "${image}" not found in ${file}`,
            "update operator/pin-images.ts to match the current FROM line, or remove the mapping if the image is gone",
        );
    }

    step(`Resolving ${image}`);
    const digest = await resolveDigest(image);
    if (!digest) {
        warn(`could not resolve digest for ${image} — skipping`);
        return;
    }
    ok(`  ${image}  →  ${digest}`);
    const { content } = rewriteDockerfile(original, image, digest);
    if (content !== original) {
        await Bun.write(file, content);
    }
}

async function main(): Promise<number> {
    const docker = Bun.which("docker");
    if (!docker) {
        die("required command 'docker' is not on PATH", "Install per docs/installation-debian.md");
    }
    ensureRepoRoot(import.meta.url);

    for (const { file, image } of MAPPINGS) {
        await pin(file, image);
    }
    ok("pin complete. Review the diff:  git diff docker/");
    return 0;
}

if (import.meta.main) {
    const code = await main();
    process.exit(code);
}
