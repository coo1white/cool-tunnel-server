<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Contracts;

/**
 * Contract for the fast-path revocation bus that publishes
 * account / server-config changes to the Rust daemon's
 * `cool_tunnel:revocations` channel.
 *
 * The bus is the ≤100 ms hot path of the dual-path defense
 * (paired with the queued slow-path render backstop in
 * `App\Messages\ReloadSingBox` / `ReloadServerConfig`).
 *
 * All publish methods are fire-and-forget. Failures (Redis
 * unreachable, auth refused, network blip) MUST be logged at
 * `warning` and MUST NOT throw out of the method — the slow
 * path is the consistency layer, not this one. Callers don't
 * need to handle bus-down explicitly.
 *
 * Status methods (`setAccountStatus` / `clearAccountStatus`)
 * are forward-compatible with the v0.1 per-request auth hook
 * design; today the Rust daemon consults the channel-based
 * pub/sub events, but a future client may also read the
 * persistent status keys directly.
 *
 * Real implementation: `App\Services\RedisRevocationBus`. The
 * interface name deliberately drops "Redis" from the contract
 * — the transport is an implementation detail.
 */
interface RevocationBusInterface
{
    public function announceAccountChanged(string $username, string $reason): void;

    public function announceServerConfigChanged(): void;

    public function announceResync(): void;

    public function setAccountStatus(string $username, string $status): void;

    public function clearAccountStatus(string $username): void;
}
