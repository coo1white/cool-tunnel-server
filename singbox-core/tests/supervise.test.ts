// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/tests/supervise.test.ts — supervisor watch helpers.

import { expect, test } from "bun:test";
import {
  isConfigWatchEvent,
  migrateLegacyDomainStrategyConfig,
  shouldPollConfigRestart,
} from "../src/subcommands/supervise.ts";

const CONFIG_PATH = "/data/config/singbox.json";

test("config watcher accepts the final atomic-rename event", () => {
  expect(isConfigWatchEvent(CONFIG_PATH, "singbox.json")).toBe(true);
});

test("config watcher ignores sibling temp-file churn", () => {
  expect(isConfigWatchEvent(CONFIG_PATH, ".singbox-core.tmp.1234abcd")).toBe(false);
});

test("config watcher treats null filenames as relevant", () => {
  expect(isConfigWatchEvent(CONFIG_PATH, null)).toBe(true);
});

test("config poller restarts when mtime changes", () => {
  expect(shouldPollConfigRestart(100, 200)).toBe(true);
  expect(shouldPollConfigRestart(200, 200)).toBe(false);
  expect(shouldPollConfigRestart(200, 0)).toBe(false);
});

test("legacy direct outbound domain_strategy is migrated to domain_resolver", () => {
  const cfg: Record<string, unknown> = {
    outbounds: [
      { type: "direct", tag: "direct", domain_strategy: "prefer_ipv4", connect_timeout: "2s" },
    ],
  };

  expect(migrateLegacyDomainStrategyConfig(cfg)).toBe(true);
  expect(cfg).toEqual({
    dns: {
      servers: [{ type: "local", tag: "local-dns" }],
    },
    outbounds: [
      {
        type: "direct",
        tag: "direct",
        domain_resolver: { server: "local-dns", strategy: "ipv4_only" },
        connect_timeout: "2s",
      },
    ],
  });
});

test("legacy migration preserves an existing domain_resolver", () => {
  const cfg: Record<string, unknown> = {
    dns: {
      servers: [{ type: "local", tag: "local-dns" }],
    },
    outbounds: [
      {
        type: "direct",
        tag: "direct",
        domain_strategy: "prefer_ipv4",
        domain_resolver: { server: "custom-dns", strategy: "prefer_ipv4" },
      },
    ],
  };

  expect(migrateLegacyDomainStrategyConfig(cfg)).toBe(true);
  const outbounds = cfg.outbounds;
  expect(Array.isArray(outbounds) ? outbounds[0] : null).toEqual({
    type: "direct",
    tag: "direct",
    domain_resolver: { server: "custom-dns", strategy: "ipv4_only" },
  });
  const dns = cfg.dns as { servers?: unknown };
  expect(dns.servers).toEqual([{ type: "local", tag: "local-dns" }]);
});

test("legacy migration is a no-op for already modern configs", () => {
  const cfg: Record<string, unknown> = {
    dns: {
      servers: [{ type: "local", tag: "local-dns" }],
    },
    outbounds: [
      {
        type: "direct",
        tag: "direct",
        domain_resolver: { server: "local-dns", strategy: "ipv4_only" },
      },
    ],
  };

  expect(migrateLegacyDomainStrategyConfig(cfg)).toBe(false);
  expect(cfg).toEqual({
    dns: {
      servers: [{ type: "local", tag: "local-dns" }],
    },
    outbounds: [
      {
        type: "direct",
        tag: "direct",
        domain_resolver: { server: "local-dns", strategy: "ipv4_only" },
      },
    ],
  });
});
