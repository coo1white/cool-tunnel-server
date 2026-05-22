<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Console\Commands\CredentialLockCheck;
use PHPUnit\Framework\Attributes\Test;
use ReflectionClass;
use Tests\TestCase;

final class CredentialLockPrivacyTest extends TestCase
{
    /**
     * @param  array<string,string>  $left
     * @param  array<string,string>  $right
     * @return list<string>
     */
    private function compareMaps(array $left, array $right): array
    {
        $method = (new ReflectionClass(CredentialLockCheck::class))->getMethod('compareMaps');
        $out = $method->invoke(new CredentialLockCheck, 'db', 'rendered', $left, $right);
        $this->assertIsArray($out);

        return $out;
    }

    #[Test]
    public function credential_lock_drift_summary_reports_counts_not_usernames(): void
    {
        $failures = $this->compareMaps(
            [
                'alice@example.com' => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                'bob@example.com' => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            ],
            [
                'alice@example.com' => 'cccccccc-cccc-cccc-cccc-cccccccccccc',
                'carol@example.com' => 'dddddddd-dddd-dddd-dddd-dddddddddddd',
            ],
        );

        $summary = implode('; ', $failures);

        $this->assertStringContainsString('missing_in_rendered=1', $summary);
        $this->assertStringContainsString('extra_in_rendered=1', $summary);
        $this->assertStringContainsString('uuid_mismatch=1', $summary);
        $this->assertStringNotContainsString('alice@example.com', $summary);
        $this->assertStringNotContainsString('bob@example.com', $summary);
        $this->assertStringNotContainsString('carol@example.com', $summary);
    }
}
