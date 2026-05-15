// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/sot-runners.ts — runtime probes for the
// panel_domain SoT fixture matrix.
//
// Two flavours:
//   - host: `php -r ...` + `cargo run --manifest-path core/...` on the
//     host PATH. Used by `make verify-sot` and `make ci`.
//   - vps:  `docker compose exec -T -e DOMAIN=... -e PANEL_DOMAIN=...
//     panel ...` against the running panel container. Used by
//     `make verify-sot-vps` and by the sot-parity ballast check.
//
// The pure fixture matrix + equivalence logic lives in sot.ts; this
// file just supplies callable runners.

import { $ } from "bun";
import type { Fixture, ProbeResult, Runner } from "./sot";

// Minimal PHP bootstrap mirroring scripts/verify_sot.sh: autoloader
// + env() shim + direct require of the config. Variables ($_ENV,
// $cfg) are interpolated by PHP, not by the shell.
const PHP_SNIPPET_HOST = `
$_ENV["DOMAIN"] = getenv("DOMAIN") ?: "";
$_ENV["PANEL_DOMAIN"] = getenv("PANEL_DOMAIN") ?: "";
if (!function_exists("env")) {
    function env($k, $d = null) {
        $v = $_ENV[$k] ?? null;
        return $v !== null && $v !== "" ? $v : $d;
    }
}
require "panel/vendor/autoload.php";
$cfg = require "panel/config/cool-tunnel.php";
echo $cfg["panel_domain"];
`;

const PHP_SNIPPET_VPS = `
chdir("/var/www/html");
$_ENV["DOMAIN"] = getenv("DOMAIN") ?: "";
$_ENV["PANEL_DOMAIN"] = getenv("PANEL_DOMAIN") ?: "";
if (!function_exists("env")) {
    function env($k, $d = null) {
        $v = $_ENV[$k] ?? null;
        return $v !== null && $v !== "" ? $v : $d;
    }
}
require "vendor/autoload.php";
$cfg = require "config/cool-tunnel.php";
echo $cfg["panel_domain"];
`;

export function makeHostRunner(): Runner {
    return async (fixture: Fixture): Promise<ProbeResult> => {
        const env = {
            ...process.env,
            DOMAIN: fixture.domain,
            PANEL_DOMAIN: fixture.panel_domain,
        };
        const php = await $`php -r ${PHP_SNIPPET_HOST}`.env(env).nothrow().quiet();
        const cargo = process.env["CARGO"] ?? "cargo";
        const rust = await $`${cargo} run --quiet --manifest-path core/Cargo.toml --bin ct-server-core -- admin panel-domain`
            .env(env)
            .nothrow()
            .quiet();
        return {
            php: php.exitCode === 0 ? php.stdout.toString() : "",
            rust: rust.exitCode === 0 ? rust.stdout.toString().trimEnd() : "",
            rustExit: rust.exitCode,
        };
    };
}

export function makeVpsRunner(): Runner {
    return async (fixture: Fixture): Promise<ProbeResult> => {
        const php = await $`docker compose exec -T -e DOMAIN=${fixture.domain} -e PANEL_DOMAIN=${fixture.panel_domain} panel php -r ${PHP_SNIPPET_VPS}`
            .nothrow()
            .quiet();
        const rust = await $`docker compose exec -T -e DOMAIN=${fixture.domain} -e PANEL_DOMAIN=${fixture.panel_domain} panel ct-server-core admin panel-domain`
            .nothrow()
            .quiet();
        return {
            php: php.exitCode === 0 ? php.stdout.toString() : "",
            rust: rust.exitCode === 0 ? rust.stdout.toString().trimEnd() : "",
            rustExit: rust.exitCode,
        };
    };
}
