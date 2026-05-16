<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Contracts;

// Surface used by SubscriptionController for v0.3.x runtime cross-end
// pin confirmation. Extracted from the concrete NaivePinReader so
// tests (and future alternative readers — e.g. one that reaches
// across to ct-naive via the docker socket) can implement it without
// subclassing the production reader, which is intentionally final.
interface NaivePinReaderInterface
{
    /**
     * @return array{upstream_tag:string, naive_version:string}|null
     */
    public function read(bool $useCache = true): ?array;
}
