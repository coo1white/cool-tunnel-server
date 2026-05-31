// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/env.test.ts — .env parser.

import { expect, test } from "bun:test";
import { mergeEnv, parseDotenv } from "../src/util/env";

test("parseDotenv handles simple KEY=value lines", () => {
  const env = parseDotenv("DOMAIN=proxy.example.com\nPORT=443\n");
  expect(env.DOMAIN).toBe("proxy.example.com");
  expect(env.PORT).toBe("443");
});

test("parseDotenv strips comments and blank lines", () => {
  const env = parseDotenv("# comment\nDOMAIN=a\n\n# another\nX=1\n");
  expect(env.DOMAIN).toBe("a");
  expect(env.X).toBe("1");
  expect(Object.keys(env)).toHaveLength(2);
});

test("parseDotenv strips inline comments on unquoted values only", () => {
  const env = parseDotenv('A=value # comment\nB=has#hash\nC="quoted # value"\n');
  expect(env.A).toBe("value");
  expect(env.B).toBe("has#hash");
  expect(env.C).toBe("quoted # value");
});

test("parseDotenv strips surrounding quotes", () => {
  const env = parseDotenv(`A="hello world"\nB='single quoted'\nC=bare\n`);
  expect(env.A).toBe("hello world");
  expect(env.B).toBe("single quoted");
  expect(env.C).toBe("bare");
});

test("parseDotenv ignores lines with no = sign", () => {
  const env = parseDotenv("FOO\nBAR=ok\n");
  expect(env.BAR).toBe("ok");
  expect(env.FOO).toBeUndefined();
});

test("mergeEnv: base (process.env) overrides overlay (.env)", () => {
  const merged = mergeEnv(
    { DOMAIN: "from-process" },
    { DOMAIN: "from-dotenv", ONLY_IN_DOTENV: "x" },
  );
  expect(merged.DOMAIN).toBe("from-process");
  expect(merged.ONLY_IN_DOTENV).toBe("x");
});

test("mergeEnv tolerates null overlay", () => {
  const merged = mergeEnv({ X: "y" }, null);
  expect(merged.X).toBe("y");
});

test("mergeEnv expands PANEL_DOMAIN references used by admin URL settings", () => {
  const merged = mergeEnv(
    {},
    {
      PANEL_DOMAIN: "panel.example.com",
      BETTER_AUTH_URL: "https://${PANEL_DOMAIN}",
      APP_URL: "https://${PANEL_DOMAIN}",
    },
  );
  expect(merged.BETTER_AUTH_URL).toBe("https://panel.example.com");
  expect(merged.APP_URL).toBe("https://panel.example.com");
});
