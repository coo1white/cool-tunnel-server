// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/tests/render.test.ts — pure-logic tests for config rendering.

import { test, expect } from "bun:test";
import {
    renderServerConfig,
    renderClientConfig,
    type ServerRenderInput,
    type ClientRenderInput,
} from "../src/config/render.ts";

const SERVER_INPUT: ServerRenderInput = {
    domain: "naive.example.com",
    listen_port: 443,
    reality_private_key: "EFOpHzZ8eSPQjGr5Tg2cFGSXgC7y5sN3yMpZJ_TT-Eo",
    reality_short_ids: [""],
    reality_dest_host: "www.microsoft.com",
    reality_dest_port: 443,
    accounts: [{ username: "test1", uuid: "550e8400-e29b-41d4-a716-446655440000" }],
};

test("renderServerConfig produces a valid-shape VLESS+Reality inbound", () => {
    const cfg = renderServerConfig(SERVER_INPUT);
    expect(cfg.inbounds.length).toBe(1);
    const inbound = cfg.inbounds[0]!;
    expect(inbound.type).toBe("vless");
    if (inbound.type !== "vless") throw new Error("unreachable");
    expect(inbound.listen_port).toBe(443);
    expect(inbound.users.length).toBe(1);
    expect(inbound.users[0]!.uuid).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(inbound.users[0]!.flow).toBe("xtls-rprx-vision");
    expect(inbound.tls.enabled).toBe(true);
    expect(inbound.tls.reality.enabled).toBe(true);
    expect(inbound.tls.reality.handshake.server).toBe("www.microsoft.com");
    expect(inbound.tls.reality.private_key).toBe(SERVER_INPUT.reality_private_key);
});

test("renderServerConfig rejects empty accounts", () => {
    expect(() => renderServerConfig({ ...SERVER_INPUT, accounts: [] })).toThrow(
        /at least one account required/,
    );
});

test("renderServerConfig rejects missing reality_private_key", () => {
    expect(() => renderServerConfig({ ...SERVER_INPUT, reality_private_key: "" })).toThrow(
        /reality_private_key is required/,
    );
});

test("renderServerConfig rejects missing reality_dest_host", () => {
    expect(() => renderServerConfig({ ...SERVER_INPUT, reality_dest_host: "" })).toThrow(
        /reality_dest_host is required/,
    );
});

test("renderServerConfig short_ids default to single empty string when input is empty", () => {
    const cfg = renderServerConfig({ ...SERVER_INPUT, reality_short_ids: [] });
    const inbound = cfg.inbounds[0]!;
    if (inbound.type !== "vless") throw new Error("unreachable");
    expect(inbound.tls.reality.short_id).toEqual([""]);
});

const CLIENT_INPUT: ClientRenderInput = {
    server_host: "naive.example.com",
    server_port: 443,
    uuid: "550e8400-e29b-41d4-a716-446655440000",
    reality_public_key: "XryQTlcZ2YuT2CMlsFwT_kSCkqzCnIDpQ-Dn9wzaPHE",
    reality_short_id: "",
    reality_dest_host: "www.microsoft.com",
    socks_listen_host: "127.0.0.1",
    socks_listen_port: 1080,
};

test("renderClientConfig produces a SOCKS inbound + VLESS outbound + utls fingerprint", () => {
    const cfg = renderClientConfig(CLIENT_INPUT);
    expect(cfg.inbounds.length).toBe(1);
    const inbound = cfg.inbounds[0]!;
    expect(inbound.type).toBe("socks");
    if (inbound.type !== "socks") throw new Error("unreachable");
    expect(inbound.listen_port).toBe(1080);

    const vlessOut = cfg.outbounds.find((o) => o.type === "vless");
    expect(vlessOut).toBeDefined();
    if (vlessOut?.type !== "vless") throw new Error("unreachable");
    expect(vlessOut.server).toBe("naive.example.com");
    expect(vlessOut.uuid).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(vlessOut.tls.utls?.fingerprint).toBe("chrome");
    expect(vlessOut.tls.reality.public_key).toBe(CLIENT_INPUT.reality_public_key);

    // Route final must be the VLESS outbound so non-DNS traffic gets proxied.
    expect(cfg.route?.final).toBe("vless-out");
});

test("renderClientConfig rejects missing public_key or uuid", () => {
    expect(() => renderClientConfig({ ...CLIENT_INPUT, reality_public_key: "" })).toThrow(
        /reality_public_key is required/,
    );
    expect(() => renderClientConfig({ ...CLIENT_INPUT, uuid: "" })).toThrow(/uuid is required/);
});
