#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/sync-naive-pin.ts — single-source-of-truth sync for the
// naive binary pin.
//
// Background. The v0.3.0 architecture is built on a single invariant:
// the same klzgrad/naiveproxy `naive` binary runs as the SERVER (in
// the ct-naive container) and as the anti-tracking probe CLIENT
// (bundled in the panel image). If those two versions drift, the
// probe stops resembling a real macOS client, defeating the whole
// point of the v0.3.0 cut. (The v0.2.x sing-box vs. bundled-naive
// padding-protocol drift is exactly the failure mode this prevents.)
//
// Until now the pin lived in two separate places:
//   - docker/naive/naive.upstream.json   (server-side; x64 only)
//   - docker/panel/Dockerfile ARG lines  (client-side; per-arch SHAs)
// Operators could — and did — bump one without the other.
//
// This script makes manifests/naive.upstream.json the canonical pin
// and rewrites the ARG defaults in both Dockerfiles in lockstep:
//
//   bun run sync-naive-pin.ts            # rewrite in place
//   bun run sync-naive-pin.ts --check    # exit 1 on drift, no write
//
// The `--check` mode is wired into `ct update` preflight and CI;
// the rewriting mode is wired into `make sync-naive-pin`.
//
// Pattern is intentionally parallel to operator/pin-images.ts.

import { die, makeTerm } from "./src/util/term";
import { ensureRepoRoot } from "./src/util/repo-root";

const { step, ok, warn } = makeTerm();

// ---------- canonical manifest ----------

export interface NaiveAsset {
    readonly url: string;
    readonly sha256: string;
}

export interface NaivePin {
    readonly upstream_tag: string;
    readonly assets: {
        readonly "linux-x64": NaiveAsset;
        readonly "linux-arm64": NaiveAsset;
    };
}

/**
 * Validate the parsed JSON has the shape we depend on. The schema
 * is internal-only so we throw on any missing field — this is the
 * one place we don't want to be polite about malformed input.
 */
export function validatePin(raw: unknown): NaivePin {
    if (!raw || typeof raw !== "object") {
        throw new Error("manifest: not a JSON object");
    }
    const o = raw as Record<string, unknown>;
    const tag = o["upstream_tag"];
    if (typeof tag !== "string" || !tag.startsWith("v")) {
        throw new Error("manifest: upstream_tag must be a string starting with 'v'");
    }
    const assetsRaw = o["assets"];
    if (!assetsRaw || typeof assetsRaw !== "object") {
        throw new Error("manifest: assets missing");
    }
    const assets = assetsRaw as Record<string, unknown>;
    for (const arch of ["linux-x64", "linux-arm64"] as const) {
        const a = assets[arch];
        if (!a || typeof a !== "object") {
            throw new Error(`manifest: assets[${arch}] missing`);
        }
        const ao = a as Record<string, unknown>;
        const url = ao["url"];
        const sha = ao["sha256"];
        if (typeof url !== "string" || !url.startsWith("https://")) {
            throw new Error(`manifest: assets[${arch}].url must be https://...`);
        }
        if (typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha)) {
            throw new Error(`manifest: assets[${arch}].sha256 must be 64 hex chars`);
        }
    }
    return raw as NaivePin;
}

// ---------- pure rewriters ----------

// Match an ARG line whose default value we want to keep aligned with
// the canonical manifest. Match is anchored to the start of the line
// + the ARG keyword + the named variable, so a stray reference to
// the same string inside a RUN block won't trip it.
export function argLineRe(name: string): RegExp {
    return new RegExp(`^(ARG\\s+${name}=)(\\S+)(\\s*)$`);
}

/**
 * Replace the default for a single ARG variable. Returns the new
 * body plus a list of (name, before, after) tuples for diff display.
 * Throws if the ARG line isn't found — silent no-ops are how the
 * old pin-images mappings rotted.
 */
export function rewriteArg(
    body: string,
    name: string,
    value: string,
): { content: string; before: string | null } {
    const re = argLineRe(name);
    let before: string | null = null;
    const out = body.split("\n").map((line) => {
        const m = re.exec(line);
        if (!m) return line;
        before = m[2] ?? null;
        return `${m[1]}${value}${m[3] ?? ""}`;
    });
    if (before === null) {
        throw new Error(`ARG ${name}=… not found`);
    }
    return { content: out.join("\n"), before };
}

export interface DriftRow {
    readonly file: string;
    readonly arg: string;
    readonly want: string;
    readonly have: string;
}

/**
 * Rewrite the three ARG lines in docker/naive/Dockerfile (server)
 * and the three ARG lines in docker/panel/Dockerfile (client).
 *
 * Returns the per-arg drift rows that WOULD have been corrected —
 * empty array means already in sync.
 */
export function planNaiveSync(
    pin: NaivePin,
    naiveDockerfile: string,
    panelDockerfile: string,
): {
    naiveOut: string;
    panelOut: string;
    drift: readonly DriftRow[];
} {
    const drift: DriftRow[] = [];

    // Server-side (docker/naive/Dockerfile) — linux-x64 only; the
    // ct-naive container has no arm64 build at this layer because
    // production VPS targets are amd64. (The panel image keeps an
    // arm64 lane because the panel image is the only thing operators
    // sometimes cross-build for ARM dev boxes; see docker/panel/
    // Dockerfile head comment.)
    let naiveOut = naiveDockerfile;
    for (const [arg, want] of [
        ["NAIVE_TAG", pin.upstream_tag],
        ["NAIVE_URL", pin.assets["linux-x64"].url],
        ["NAIVE_SHA256", pin.assets["linux-x64"].sha256],
    ] as const) {
        const r = rewriteArg(naiveOut, arg, want);
        if (r.before !== want) {
            drift.push({ file: "docker/naive/Dockerfile", arg, want, have: r.before ?? "?" });
        }
        naiveOut = r.content;
    }

    // Panel-side (docker/panel/Dockerfile) — per-arch SHAs + the
    // shared NAIVE_VERSION (asset tag).
    let panelOut = panelDockerfile;
    for (const [arg, want] of [
        ["NAIVE_VERSION", pin.upstream_tag],
        ["NAIVE_SHA256_AMD64", pin.assets["linux-x64"].sha256],
        ["NAIVE_SHA256_ARM64", pin.assets["linux-arm64"].sha256],
    ] as const) {
        const r = rewriteArg(panelOut, arg, want);
        if (r.before !== want) {
            drift.push({ file: "docker/panel/Dockerfile", arg, want, have: r.before ?? "?" });
        }
        panelOut = r.content;
    }

    return { naiveOut, panelOut, drift };
}

// ---------- side-effecting driver ----------

const MANIFEST_PATH = "manifests/naive.upstream.json";
const NAIVE_DOCKERFILE = "docker/naive/Dockerfile";
const PANEL_DOCKERFILE = "docker/panel/Dockerfile";

async function loadPin(): Promise<NaivePin> {
    const f = Bun.file(MANIFEST_PATH);
    if (!(await f.exists())) {
        die(
            `sync-naive-pin: ${MANIFEST_PATH} not found`,
            "this file is the canonical naive pin — restore it from git",
        );
    }
    try {
        return validatePin(JSON.parse(await f.text()));
    } catch (e) {
        die(
            `sync-naive-pin: ${MANIFEST_PATH} is malformed`,
            e instanceof Error ? e.message : String(e),
        );
    }
}

async function main(argv: readonly string[]): Promise<number> {
    ensureRepoRoot(import.meta.url);
    const check = argv.includes("--check");

    const pin = await loadPin();
    const naiveBody = await Bun.file(NAIVE_DOCKERFILE).text();
    const panelBody = await Bun.file(PANEL_DOCKERFILE).text();

    let plan;
    try {
        plan = planNaiveSync(pin, naiveBody, panelBody);
    } catch (e) {
        die(
            `sync-naive-pin: could not locate an ARG line`,
            (e instanceof Error ? e.message : String(e)) +
                "\n  expected: ARG NAIVE_TAG=…, ARG NAIVE_URL=…, ARG NAIVE_SHA256=…" +
                "\n  in docker/naive/Dockerfile and" +
                "\n  ARG NAIVE_VERSION=…, ARG NAIVE_SHA256_AMD64=…, ARG NAIVE_SHA256_ARM64=…" +
                "\n  in docker/panel/Dockerfile",
        );
    }

    step(`canonical: ${pin.upstream_tag}`);
    if (plan.drift.length === 0) {
        ok("docker/naive/Dockerfile + docker/panel/Dockerfile already match");
        return 0;
    }

    for (const d of plan.drift) {
        process.stdout.write(`  drift: ${d.file}::${d.arg}\n`);
        process.stdout.write(`           have ${d.have}\n`);
        process.stdout.write(`           want ${d.want}\n`);
    }

    if (check) {
        process.stdout.write(
            `\n✗ naive pin drift detected (${plan.drift.length} field${plan.drift.length === 1 ? "" : "s"}).\n` +
                `  fix: bun run operator/sync-naive-pin.ts   (or: make sync-naive-pin)\n`,
        );
        return 1;
    }

    if (plan.naiveOut !== naiveBody) await Bun.write(NAIVE_DOCKERFILE, plan.naiveOut);
    if (plan.panelOut !== panelBody) await Bun.write(PANEL_DOCKERFILE, plan.panelOut);
    ok(`rewrote ${plan.drift.length} ARG line${plan.drift.length === 1 ? "" : "s"}`);
    warn("review the diff:  git diff docker/naive/Dockerfile docker/panel/Dockerfile");
    return 0;
}

if (import.meta.main) {
    const code = await main(process.argv.slice(2));
    process.exit(code);
}
