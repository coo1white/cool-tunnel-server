// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/laravel-key.test.ts

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
    describeLaravelKey,
    encryptionFailureHint,
    loadLaravelKeyEnv,
    splitPreviousKeys,
    summarizeLaravelKeyEnv,
} from "../src/util/laravel-key";

const GOOD = "base64:JCsdgKuqbLm9GnIQ6L+8MKf1gfgPYxKCWgVJB8x3qvE=";
const OTHER_GOOD = "base64:8v7nRLiRDXINrWKaa91TAFuZE+TT1pdgyWnZBdbHHGQ=";

test("describeLaravelKey reports valid Laravel key shape without printing the key", () => {
    const diagnostic = describeLaravelKey("APP_KEY", GOOD);

    expect(diagnostic.status).toBe("ok");
    expect(diagnostic.detail).toContain("32 bytes");
    expect(diagnostic.detail).not.toContain(GOOD);
});

test("describeLaravelKey distinguishes malformed base64 from wrong decoded length", () => {
    expect(describeLaravelKey("APP_KEY", "not-a-key").detail).toContain("not valid base64:<value>");
    expect(describeLaravelKey("APP_KEY", "base64:Zm9v").detail).toContain("decodes to 3 bytes");
});

test("splitPreviousKeys trims blank comma-separated entries", () => {
    expect(splitPreviousKeys(` ${GOOD}, , ${OTHER_GOOD} `)).toEqual([GOOD, OTHER_GOOD]);
});

test("summarizeLaravelKeyEnv pinpoints malformed APP_PREVIOUS_KEYS entries", () => {
    const lines = summarizeLaravelKeyEnv({
        APP_KEY: GOOD,
        APP_PREVIOUS_KEYS: `${OTHER_GOOD},base64:Zm9v`,
    });
    const text = lines.join("\n");

    expect(text).toContain("APP_KEY is present");
    expect(text).toContain("APP_PREVIOUS_KEYS has 2 entries, 1 malformed");
    expect(text).toContain("APP_PREVIOUS_KEYS[2] is malformed");
    expect(text).toContain("docker compose restart panel");
    expect(text).not.toContain(GOOD);
    expect(text).not.toContain(OTHER_GOOD);
});

test("encryptionFailureHint prefers APP_PREVIOUS_KEYS repair when current key is valid", () => {
    const text = encryptionFailureHint({
        APP_KEY: GOOD,
        APP_PREVIOUS_KEYS: "base64:Zm9v",
    }, "recover").join("\n");

    expect(text).toContain("APP_PREVIOUS_KEYS contains malformed fallback keys");
    expect(text).toContain("Fix or remove malformed APP_PREVIOUS_KEYS");
    expect(text).not.toContain("run: ct recover reset-reality");
});

test("encryptionFailureHint points decrypt drift at old key or reset when key formats are valid", () => {
    const text = encryptionFailureHint({
        APP_KEY: GOOD,
        APP_PREVIOUS_KEYS: OTHER_GOOD,
    }, "render").join("\n");

    expect(text).toContain("APP_KEY format looks valid");
    expect(text).toContain("Restore the old APP_KEY");
    expect(text).toContain("ct recover reset-reality");
    expect(text).not.toContain(GOOD);
});

test("loadLaravelKeyEnv lets process env override .env values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ct-laravel-key-"));
    try {
        await Bun.write(join(dir, ".env"), `APP_KEY=${GOOD}\nAPP_PREVIOUS_KEYS=base64:Zm9v\n`);

        const env = await loadLaravelKeyEnv(dir, { APP_KEY: OTHER_GOOD });

        expect(env["APP_KEY"]).toBe(OTHER_GOOD);
        expect(env["APP_PREVIOUS_KEYS"]).toBe("base64:Zm9v");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
