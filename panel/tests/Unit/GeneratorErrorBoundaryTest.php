<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Unit;

use App\Contracts\CtServerCoreInterface;
use App\Services\CaddyfileGenerator;
use App\Services\SingBoxConfigGenerator;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// Pins the error-boundary contract of the two thin shell-out
// generators that bridge the panel save flow to ct-server-core:
//
//   - \RuntimeException (CtServerCore::run on non-zero exit, sing-box
//     check timeout, docker hiccup) is "soft": the surrounding model
//     save still commits, renderToFile returns null, the every-5-min
//     scheduler reconciles.
//
//   - \Error (TypeError, ArgumentCountError, undefined-method,
//     class-not-found) is "hard": code defect, the catch must re-
//     throw so the surrounding save fails with a visible 500 instead
//     of silently leaving the panel/proxy diverged. v0.0.9 had
//     exactly this bug: renderToFile called renderCaddyfile() by
//     copy-paste error, every save hit it, the catch silenced it.
//
// The fix in v0.1.x narrows the catch's behaviour but keeps the
// log_critical trace for both cases. These tests pin that contract
// so a future refactor doesn't re-introduce the silent-Error path.

final class GeneratorErrorBoundaryTest extends TestCase
{
    #[Test]
    public function singbox_soft_fails_on_runtime_exception(): void
    {
        $core = $this->createMock(CtServerCoreInterface::class);
        $core->method('renderSingBoxConfig')
            ->willThrowException(new \RuntimeException('docker exec failed'));

        $gen = new SingBoxConfigGenerator($core);
        $result = $gen->renderToFile();

        $this->assertNull(
            $result,
            'A transient \RuntimeException must soft-fail to null so the surrounding save still commits.',
        );
    }

    #[Test]
    public function singbox_rethrows_on_error(): void
    {
        $core = $this->createMock(CtServerCoreInterface::class);
        $core->method('renderSingBoxConfig')
            ->willThrowException(new \TypeError('called undefined method'));

        $gen = new SingBoxConfigGenerator($core);

        $this->expectException(\Error::class);
        $this->expectExceptionMessage('called undefined method');
        $gen->renderToFile();
    }

    #[Test]
    public function singbox_returns_hash_on_changed_render(): void
    {
        $core = $this->createMock(CtServerCoreInterface::class);
        $core->method('renderSingBoxConfig')->willReturn([
            'hash' => 'deadbeefcafebabe',
            'changed' => true,
            'bytes' => 1024,
        ]);

        $gen = new SingBoxConfigGenerator($core);

        $this->assertSame('deadbeefcafebabe', $gen->renderToFile());
    }

    #[Test]
    public function singbox_returns_null_on_unchanged_render(): void
    {
        $core = $this->createMock(CtServerCoreInterface::class);
        $core->method('renderSingBoxConfig')->willReturn([
            'hash' => 'abcd',
            'changed' => false,
        ]);

        $gen = new SingBoxConfigGenerator($core);

        $this->assertNull(
            $gen->renderToFile(),
            'When changed=false, renderToFile MUST return null to skip the reload.',
        );
    }

    #[Test]
    public function caddyfile_soft_fails_on_runtime_exception(): void
    {
        $core = $this->createMock(CtServerCoreInterface::class);
        $core->method('renderCaddyfile')
            ->willThrowException(new \RuntimeException('ct-server-core exited 1'));

        $gen = new CaddyfileGenerator($core);

        $this->assertNull($gen->renderToFile());
    }

    #[Test]
    public function caddyfile_rethrows_on_error(): void
    {
        $core = $this->createMock(CtServerCoreInterface::class);
        $core->method('renderCaddyfile')
            ->willThrowException(new \Error('class not found'));

        $gen = new CaddyfileGenerator($core);

        $this->expectException(\Error::class);
        $gen->renderToFile();
    }
}
