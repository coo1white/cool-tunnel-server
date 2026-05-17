<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Contracts;

/**
 * Reads the pinned sing-box upstream tag the panel container was
 * built against — the canonical value the subscription endpoint
 * splices into manifests' `server_singbox_pin` block so the v3.0.0+
 * client can confirm cross-end binary identity at runtime.
 *
 * The pin lives in singbox-core/singbox.upstream.json::upstream_tag
 * and is embedded at Bun-compile time into /usr/local/bin/singbox-
 * core. `singbox-core version --json` reads it back out at runtime —
 * fast, deterministic, and the same source of truth on both ends.
 *
 * Implementations MUST cache the value across requests; the
 * underlying file is immutable for the lifetime of the panel
 * container, so re-shelling per request is pure waste.
 */
interface SingboxPinReaderInterface
{
    /**
     * Return the pinned sing-box upstream tag (e.g. "v1.13.12") or
     * `null` if the binary is missing / unreadable / non-conformant.
     *
     * `null` is the "soft-fail" signal — the controller treats it as
     * "skip the pin block in the manifest" rather than as a hard
     * failure (older or partial deploys may legitimately not have
     * singbox-core wired). Operators see a critical log line.
     */
    public function upstreamTag(): ?string;
}
