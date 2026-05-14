// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/env.test.ts — .env parser.

import { test, expect } from "bun:test";
import { parseDotenv, mergeEnv } from "../src/util/env";

test("parseDotenv handles simple KEY=value lines", () => {
    const env = parseDotenv("DOMAIN=proxy.example.com\nPORT=443\n");
    expect(env["DOMAIN"]).toBe("proxy.example.com");
    expect(env["PORT"]).toBe("443");
});

test("parseDotenv strips comments and blank lines", () => {
    const env = parseDotenv("# comment\nDOMAIN=a\n\n# another\nX=1\n");
    expect(env["DOMAIN"]).toBe("a");
    expect(env["X"]).toBe("1");
    expect(Object.keys(env)).toHaveLength(2);
});

test("parseDotenv strips surrounding quotes", () => {
    const env = parseDotenv(`A="hello world"\nB='single quoted'\nC=bare\n`);
    expect(env["A"]).toBe("hello world");
    expect(env["B"]).toBe("single quoted");
    expect(env["C"]).toBe("bare");
});

test("parseDotenv ignores lines with no = sign", () => {
    const env = parseDotenv("FOO\nBAR=ok\n");
    expect(env["BAR"]).toBe("ok");
    expect(env["FOO"]).toBeUndefined();
});

test("mergeEnv: base (process.env) overrides overlay (.env)", () => {
    const merged = mergeEnv({ DOMAIN: "from-process" }, { DOMAIN: "from-dotenv", ONLY_IN_DOTENV: "x" });
    expect(merged["DOMAIN"]).toBe("from-process");
    expect(merged["ONLY_IN_DOTENV"]).toBe("x");
});

test("mergeEnv tolerates null overlay", () => {
    const merged = mergeEnv({ X: "y" }, null);
    expect(merged["X"]).toBe("y");
});
