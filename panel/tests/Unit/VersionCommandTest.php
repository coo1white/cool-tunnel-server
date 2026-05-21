<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Unit;

use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// Cycle 2 panel drift-detection probe (v0.0.39). The matcher in
// core/ct-server-core/src/components.rs asserts
// `installed.contains(&m.version)` against the pinned version in
// manifests/panel.upstream.json. The artisan command's stdout is
// what `installed` resolves to — drift in the output shape
// (extra prefix, ANSI escapes, version key renamed) silently
// breaks drift detection in production. These tests anchor the
// contract at unit-test time.

class VersionCommandTest extends TestCase
{
    #[Test]
    public function emits_panel_identity_with_configured_version(): void
    {
        // Pin a known value so the test does not depend on
        // whatever the current release config is. Restore at the
        // end via Laravel's config-reset between tests, but be
        // explicit to keep the assertion line readable.
        config(['cool-tunnel.version' => '9.9.9']);

        $this->artisan('ct:version')
            ->expectsOutput('cool-tunnel-server panel 9.9.9')
            ->assertSuccessful();
    }

    #[Test]
    public function fails_loudly_when_version_config_is_missing(): void
    {
        // If the panel image is built without panel/config/cool-tunnel.php
        // populated (mis-merge, stripped config layer), the probe must
        // exit non-zero so `expect_zero_exit: true` on the manifest
        // flips the row to VerifyFailed — silent zero-exit-with-empty-
        // line would have made the matcher's `None => Ok` corner case
        // load-bearing again, exactly the v0.0.35 trap Cycle 1 closed.
        config(['cool-tunnel.version' => '']);

        $this->artisan('ct:version')->assertFailed();
    }

    #[Test]
    public function emitted_version_matches_pinned_manifest_version(): void
    {
        // panel/config/cool-tunnel.php's version key MUST equal
        // manifests/panel.upstream.json's version field. `make
        // set-version` keeps the two in lockstep; this test is the
        // unit-test-time sanity belt.
        $manifestPath = base_path('../manifests/panel.upstream.json');
        $this->assertFileExists($manifestPath);

        $manifest = json_decode((string) file_get_contents($manifestPath), true);
        $this->assertIsArray($manifest);
        $this->assertArrayHasKey('version', $manifest);

        $this->assertSame(
            $manifest['version'],
            config('cool-tunnel.version'),
            'panel/config/cool-tunnel.php::version must equal manifests/panel.upstream.json::version'
        );
    }
}
