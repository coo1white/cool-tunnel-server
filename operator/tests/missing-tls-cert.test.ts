// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/missing-tls-cert.test.ts — v0.4+ Caddy ACME recipe helpers.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { panelDomain } from "../src/tasks/recipes/missing_tls_cert";
import type { RunContext } from "../src/runner/context";

function ctx(cwd: string, env: Record<string, string> = {}): RunContext {
    return {
        cwd,
        env,
        json: false,
        noBridge: true,
        interactive: false,
        logger: {
            debug() {},
            info() {},
            warn() {},
            error() {},
        },
    };
}

test("panelDomain prefers PANEL_DOMAIN from .env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ct-missing-cert-"));
    try {
        await writeFile(join(dir, ".env"), "DOMAIN=life.example\nPANEL_DOMAIN=panel.life.example\n");
        expect(await panelDomain(ctx(dir))).toBe("panel.life.example");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("panelDomain derives panel.DOMAIN when PANEL_DOMAIN is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ct-missing-cert-"));
    try {
        await writeFile(join(dir, ".env"), "DOMAIN=life.example\n");
        expect(await panelDomain(ctx(dir))).toBe("panel.life.example");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("panelDomain searches parent .env for dev runs from operator cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ct-missing-cert-"));
    try {
        await mkdir(join(dir, "operator"));
        await writeFile(join(dir, ".env"), "PANEL_DOMAIN=panel.parent.example\n");
        expect(await panelDomain(ctx(join(dir, "operator")))).toBe("panel.parent.example");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
