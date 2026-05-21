// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/config/types.ts — sing-box config schema (subset we render).
//
// Mirrors SagerNet/sing-box's documented JSON schema at the pinned upstream
// tag (singbox.upstream.json::upstream_tag). We intentionally type only the
// fields the renderer emits; sing-box accepts many more (multiple inbounds,
// route rules, DNS, experimental.cache_file, etc.) that we don't use.
//
// Bumping sing-box upstream MAY require updates here. The renderer's
// outputs are JSON-validated against `sing-box check -c <path>` in CI to
// catch schema drift before deploy.

/**
 * Top-level sing-box config root. Only the fields we render are typed;
 * sing-box's actual schema is the canonical source.
 */
export interface SingboxConfig {
    readonly log: LogBlock;
    readonly dns?: DnsBlock;
    readonly inbounds: readonly Inbound[];
    readonly outbounds: readonly Outbound[];
    readonly route?: RouteBlock;
}

export interface LogBlock {
    readonly level: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "panic";
    readonly disabled?: boolean;
    readonly timestamp?: boolean;
}

// ---------- DNS ----------------------------------------------------------------

export interface DnsBlock {
    readonly servers: readonly DnsServer[];
}

export type DnsServer = LocalDnsServer;

export interface LocalDnsServer {
    readonly type: "local";
    readonly tag: string;
}

// ---------- Inbounds ---------------------------------------------------------

export type Inbound = VlessInbound | SocksInbound;

export interface VlessInbound {
    readonly type: "vless";
    readonly tag: string;
    readonly listen: string; // "::" for dual-stack, "0.0.0.0" for v4-only
    readonly listen_port: number;
    readonly users: readonly VlessUser[];
    readonly tls: VlessRealityTls;
}

export interface VlessUser {
    readonly name?: string;
    readonly uuid: string;
    readonly flow: "" | "xtls-rprx-vision";
}

export interface VlessRealityTls {
    readonly enabled: true;
    readonly server_name: string; // The SNI the Reality handshake will fake
    readonly reality: RealityServerConfig;
}

export interface RealityServerConfig {
    readonly enabled: true;
    readonly handshake: RealityHandshake;
    readonly private_key: string;
    readonly short_id: readonly string[];
    readonly max_time_difference?: string; // e.g. "1m" (window for the Reality auth nonce)
}

export interface RealityHandshake {
    readonly server: string; // FQDN of the destination Reality fakes (e.g. www.microsoft.com)
    readonly server_port: number; // typically 443
}

/** Client-side SOCKS5 listener (loopback only, for app traffic). */
export interface SocksInbound {
    readonly type: "socks";
    readonly tag: string;
    readonly listen: string;
    readonly listen_port: number;
    readonly users?: readonly { username: string; password: string }[];
}

// ---------- Outbounds --------------------------------------------------------

export type Outbound = VlessOutbound | DirectOutbound | BlockOutbound | DnsOutbound;

export interface VlessOutbound {
    readonly type: "vless";
    readonly tag: string;
    readonly server: string; // FQDN of the cool-tunnel-server
    readonly server_port: number;
    readonly uuid: string;
    readonly flow: "" | "xtls-rprx-vision";
    readonly tls: VlessRealityClientTls;
}

export interface VlessRealityClientTls {
    readonly enabled: true;
    readonly server_name: string;
    readonly reality: RealityClientConfig;
    readonly utls?: { enabled: true; fingerprint: "chrome" | "firefox" | "safari" | "ios" };
}

export interface RealityClientConfig {
    readonly enabled: true;
    readonly public_key: string;
    readonly short_id: string;
}

export type DirectDomainStrategy = "prefer_ipv4" | "prefer_ipv6" | "ipv4_only" | "ipv6_only";

export interface DirectOutbound {
    readonly type: "direct";
    readonly tag: string;
    readonly domain_resolver?: DomainResolver;
    readonly connect_timeout?: string;
    readonly fallback_delay?: string;
}

export interface DomainResolver {
    readonly server: string;
    readonly strategy?: DirectDomainStrategy;
}

export interface BlockOutbound {
    readonly type: "block";
    readonly tag: string;
}

export interface DnsOutbound {
    readonly type: "dns";
    readonly tag: string;
}

// ---------- Route ------------------------------------------------------------

export interface RouteBlock {
    readonly rules?: readonly RouteRule[];
    readonly final?: string; // tag of the default outbound
    readonly auto_detect_interface?: boolean;
}

export interface RouteRule {
    readonly protocol?: "dns" | "http" | "tls" | "quic";
    readonly outbound: string;
}
