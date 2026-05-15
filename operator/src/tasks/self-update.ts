// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/self-update.ts — fetch a signed binary update from
// GitHub Releases, verify signature + SHA-256, atomic-rename in place.
//
// Trust model:
//   1. SHA256SUMS lists hashes for every published binary in the release.
//   2. SHA256SUMS.sig is a detached ed25519 signature over SHA256SUMS,
//      created by the project's offline signing key.
//   3. This binary has the corresponding pubkey baked in at build time
//      via BUILD_PUBKEY (set from CT_OPERATOR_PUBKEY env in build.ts).
//      If the pubkey is empty, self-update refuses.
//
// Single point of trust = the pubkey at build time. Anyone who controls
// the embedded pubkey controls who can sign updates.

import { realpath, rename, chmod, writeFile } from "node:fs/promises";
import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { sha256File, verifyEd25519 } from "../util/crypto";

declare const BUILD_VERSION: string;
declare const BUILD_PUBKEY: string;
declare const BUILD_TARGET: string;

const VERSION: string = (typeof BUILD_VERSION !== "undefined") ? BUILD_VERSION : "dev";
const PUBKEY: string = (typeof BUILD_PUBKEY !== "undefined") ? BUILD_PUBKEY : "";
const TARGET: string = (typeof BUILD_TARGET !== "undefined") ? BUILD_TARGET : "linux-x64";

const RELEASE_BASE =
    process.env["CT_OPERATOR_RELEASE_URL"] ??
    "https://github.com/coo1white/cool-tunnel-server/releases/latest/download";

const BINARY_NAME = `ct-operator-${TARGET}`;

export class SelfUpdateTask implements Task {
    readonly name = "self-update";

    async run(ctx: RunContext): Promise<TaskResult> {
        if (VERSION === "dev") {
            ctx.logger.error("self-update is not available in dev mode (would overwrite the Bun interpreter)");
            return { ok: false, code: 4, summary: "dev mode" };
        }
        if (!PUBKEY) {
            ctx.logger.error("BUILD_PUBKEY is empty — this binary has no pinned signing key. Rebuild with CT_OPERATOR_PUBKEY set.");
            return { ok: false, code: 4, summary: "no pinned pubkey" };
        }

        ctx.logger.info(`current version: ${VERSION}; target: ${TARGET}`);

        const selfPath = await realpath(process.execPath);
        ctx.logger.info(`self path: ${selfPath}`);

        // 1. Fetch SHA256SUMS + signature.
        ctx.logger.info(`fetching ${RELEASE_BASE}/SHA256SUMS …`);
        const sumsResp = await fetch(`${RELEASE_BASE}/SHA256SUMS`);
        if (!sumsResp.ok) {
            ctx.logger.error(`SHA256SUMS fetch failed: HTTP ${sumsResp.status}`);
            return { ok: false, code: 4, summary: `manifest HTTP ${sumsResp.status}` };
        }
        const sumsText = await sumsResp.text();

        const sigResp = await fetch(`${RELEASE_BASE}/SHA256SUMS.sig`);
        if (!sigResp.ok) {
            ctx.logger.error(`SHA256SUMS.sig fetch failed: HTTP ${sigResp.status}`);
            return { ok: false, code: 4, summary: `sig HTTP ${sigResp.status}` };
        }
        const sigBytes = new Uint8Array(await sigResp.arrayBuffer());

        // 2. Verify signature.
        const sumsBytes = new TextEncoder().encode(sumsText);
        if (!verifyEd25519(PUBKEY, sumsBytes, sigBytes)) {
            ctx.logger.error("SHA256SUMS signature verification FAILED. Refusing to update.");
            return { ok: false, code: 5, summary: "sig verify failed" };
        }
        ctx.logger.info("SHA256SUMS signature verified");

        // 3. Look up our target's expected hash.
        const expectedHash = parseSums(sumsText, BINARY_NAME);
        if (!expectedHash) {
            ctx.logger.error(`no entry for ${BINARY_NAME} in SHA256SUMS`);
            return { ok: false, code: 4, summary: "no entry in manifest" };
        }
        ctx.logger.info(`expected hash for ${BINARY_NAME}: ${expectedHash}`);

        // 4. Fetch the binary.
        ctx.logger.info(`fetching ${RELEASE_BASE}/${BINARY_NAME} …`);
        const binResp = await fetch(`${RELEASE_BASE}/${BINARY_NAME}`);
        if (!binResp.ok) {
            ctx.logger.error(`binary fetch failed: HTTP ${binResp.status}`);
            return { ok: false, code: 4, summary: `binary HTTP ${binResp.status}` };
        }
        const binBytes = new Uint8Array(await binResp.arrayBuffer());

        // 5. Write to <self>.new and verify the hash.
        const newPath = `${selfPath}.new`;
        await writeFile(newPath, binBytes);
        await chmod(newPath, 0o755);
        const actualHash = await sha256File(newPath);
        if (actualHash !== expectedHash) {
            ctx.logger.error(`hash mismatch: got ${actualHash}, expected ${expectedHash}`);
            return { ok: false, code: 5, summary: "binary hash mismatch" };
        }
        ctx.logger.info("binary hash verified");

        // 6. Atomic rename: <self>.new → <self>.
        await rename(newPath, selfPath);
        ctx.logger.info("installed. Re-run any ct-operator command to pick up the new version.");

        return { ok: true, code: 0, summary: "updated" };
    }
}

function parseSums(text: string, filename: string): string | null {
    for (const line of text.split("\n")) {
        // SHA256SUMS lines: "<hash>  <filename>" or "<hash> *<filename>"
        const m = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/);
        if (!m) continue;
        const hash = m[1];
        const name = m[2];
        if (name === filename) return hash ?? null;
    }
    return null;
}
