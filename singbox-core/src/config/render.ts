// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/config/render.ts — render sing-box configs.
//
// Two render entry points, sharing the VLESS+Reality types:
//
//   - renderServerConfig(input)  → sing-box config.json for the server
//                                  (ct-singbox container)
//   - renderClientConfig(input)  → sing-box config.json for the macOS
//                                  client (Cool Tunnel.app)
//
// Both renderers are pure — no I/O. Callers handle atomic-write.

import type {
    SingboxConfig,
    VlessInbound,
    VlessOutbound,
    SocksInbound,
    DirectOutbound,
    BlockOutbound,
    RouteBlock,
    DirectDomainStrategy,
} from "./types.ts";

// ---------- Server render ----------------------------------------------------

/** Inputs the server renderer accepts. */
export interface ServerRenderInput {
    /** The proxy domain (e.g. proxy.example.com). Used as SNI hint only. */
    readonly domain: string;
    /** Listen port for VLESS inbound; production-canonical is 443. */
    readonly listen_port: number;
    /**
     * Reality private key (X25519 form). Paired with public_key on the client
     * side. Generated once via `singbox-core reality-keygen`, stored in the
     * server's ServerConfig table and never rotated except by operator action.
     */
    readonly reality_private_key: string;
    /**
     * Short ID list. Each active client gets one (hex string, even length
     * 0-16 chars; "" means no short_id challenge). Stored per-ProxyAccount.
     */
    readonly reality_short_ids: readonly string[];
    /**
     * The "destination" website the Reality handshake fakes. Picks a real
     * popular HTTPS endpoint that's reachable from the server. Common
     * choices: www.microsoft.com, www.apple.com, www.cloudflare.com.
     */
    readonly reality_dest_host: string;
    /** Port of the Reality destination (almost always 443). */
    readonly reality_dest_port: number;
    /** Active accounts, each emitted as one VLESS user. */
    readonly accounts: readonly ServerAccountInput[];
    /** Log level. Production default: "info". */
    readonly log_level?: "trace" | "debug" | "info" | "warn" | "error";
    /**
     * Strategy for server-side direct outbound DNS answers. Defaults
     * to prefer_ipv4 because many VPS providers expose broken IPv6
     * routes; operators can set ipv4_only when IPv6 is fully disabled.
     */
    readonly direct_domain_strategy?: DirectDomainStrategy | "";
    /** Server-side direct outbound connect timeout, e.g. "2s". */
    readonly direct_connect_timeout?: string;
    /** Delay before trying the fallback address family, e.g. "100ms". */
    readonly direct_fallback_delay?: string;
}

export interface ServerAccountInput {
    readonly username: string;
    /** UUID per RFC 4122; sing-box uses it as the auth credential. */
    readonly uuid: string;
}

export function renderServerConfig(input: ServerRenderInput): SingboxConfig {
    if (!input.reality_private_key) {
        throw new Error("reality_private_key is required (run `singbox-core reality-keygen`)");
    }
    if (!input.reality_dest_host) {
        throw new Error("reality_dest_host is required (e.g. www.microsoft.com)");
    }
    if (input.accounts.length === 0) {
        throw new Error("at least one account required (sing-box rejects empty users[])");
    }

    const inbound: VlessInbound = {
        type: "vless",
        tag: "vless-in",
        listen: "::",
        listen_port: input.listen_port,
        users: input.accounts.map((a) => ({
            name: a.username,
            uuid: a.uuid,
            flow: "xtls-rprx-vision",
        })),
        tls: {
            enabled: true,
            server_name: input.reality_dest_host,
            reality: {
                enabled: true,
                handshake: {
                    server: input.reality_dest_host,
                    server_port: input.reality_dest_port,
                },
                private_key: input.reality_private_key,
                short_id: input.reality_short_ids.length > 0 ? input.reality_short_ids : [""],
                max_time_difference: "1m",
            },
        },
    };

    const directOut: DirectOutbound = {
        type: "direct",
        tag: "direct",
        domain_resolver: {
            server: "local-dns",
            strategy: input.direct_domain_strategy || "prefer_ipv4",
        },
        connect_timeout: input.direct_connect_timeout || "2s",
        fallback_delay: input.direct_fallback_delay || "100ms",
    };
    const blockOut: BlockOutbound = { type: "block", tag: "block" };

    return {
        log: { level: input.log_level ?? "info", timestamp: true },
        dns: {
            servers: [
                {
                    type: "local",
                    tag: "local-dns",
                },
            ],
        },
        inbounds: [inbound],
        outbounds: [directOut, blockOut],
    };
}

// ---------- Client render ----------------------------------------------------

export interface ClientRenderInput {
    /** Cool Tunnel server FQDN — e.g. proxy.example.com. */
    readonly server_host: string;
    readonly server_port: number;
    readonly uuid: string;
    readonly reality_public_key: string;
    readonly reality_short_id: string;
    /** The same destination SNI the server is faking. */
    readonly reality_dest_host: string;
    /** SOCKS5 listener for the macOS system proxy. */
    readonly socks_listen_host: string; // 127.0.0.1
    readonly socks_listen_port: number; // 1080
    readonly log_level?: "trace" | "debug" | "info" | "warn" | "error";
}

export function renderClientConfig(input: ClientRenderInput): SingboxConfig {
    if (!input.reality_public_key) {
        throw new Error("reality_public_key is required (server's keygen output)");
    }
    if (!input.uuid) {
        throw new Error("uuid is required");
    }

    const socksIn: SocksInbound = {
        type: "socks",
        tag: "socks-in",
        listen: input.socks_listen_host,
        listen_port: input.socks_listen_port,
    };

    const vlessOut: VlessOutbound = {
        type: "vless",
        tag: "vless-out",
        server: input.server_host,
        server_port: input.server_port,
        uuid: input.uuid,
        flow: "xtls-rprx-vision",
        tls: {
            enabled: true,
            server_name: input.reality_dest_host,
            utls: { enabled: true, fingerprint: "chrome" },
            reality: {
                enabled: true,
                public_key: input.reality_public_key,
                short_id: input.reality_short_id,
            },
        },
    };

    const directOut: DirectOutbound = { type: "direct", tag: "direct" };
    const blockOut: BlockOutbound = { type: "block", tag: "block" };

    const route: RouteBlock = {
        final: "vless-out",
        auto_detect_interface: true,
    };

    return {
        log: { level: input.log_level ?? "info", timestamp: true },
        inbounds: [socksIn],
        outbounds: [vlessOut, directOut, blockOut],
        route,
    };
}
