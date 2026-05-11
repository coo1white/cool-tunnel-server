<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Unit;

use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// v0.0.81 robustness-review fix (item 4). The upstream Laravel Octane
// vendor:publish stub ships `'server' => env('OCTANE_SERVER',
// 'roadrunner')`. Cool Tunnel runs FrankenPHP exclusively (see
// docker/panel/Dockerfile + supervisord.conf::frankenphp). The
// repo-root .env.example sets OCTANE_SERVER=frankenphp, so production
// is correct — but any path that loads this config without that env
// injection (cached config, post-deploy CLI, dev shell) inherited the
// upstream "roadrunner" default; `php artisan octane:reload` then
// targeted the wrong driver, found no PID, exited 0 — the worker was
// never actually recycled and the 500-request MAX_REQUESTS cap became
// the only safety net for picking up code/config changes.
//
// The fix pinned the project-owned default to "frankenphp" in
// panel/config/octane.php. This test asserts the literal text of that
// file so the bad upstream value can't sneak back in via a future
// vendor:publish refresh, a merge mishap, or a copy-paste from the
// upstream stub. The check is text-level (rather than runtime-config-
// level) because Laravel's Env helper caches reads through a shared
// repository, making per-test env manipulation unreliable.
class OctaneServerDefaultTest extends TestCase
{
    #[Test]
    public function default_octane_server_is_frankenphp(): void
    {
        $configPath = base_path('config/octane.php');
        $this->assertFileExists($configPath);

        $contents = file_get_contents($configPath);
        $this->assertIsString($contents);

        $this->assertStringContainsString(
            "env('OCTANE_SERVER', 'frankenphp')",
            $contents,
            'config/octane.php::server default must be frankenphp '.
            '(upstream stub ships roadrunner; project-owned override '.
            'is the only thing keeping octane:reload from no-op-ing on '.
            'every cached-config / post-deploy-CLI invocation).'
        );

        $this->assertStringNotContainsString(
            "env('OCTANE_SERVER', 'roadrunner')",
            $contents,
            'config/octane.php must NOT default to roadrunner — Cool Tunnel '.
            'runs FrankenPHP exclusively. See the v0.0.81 rationale block '.
            'in config/octane.php.'
        );
    }
}
