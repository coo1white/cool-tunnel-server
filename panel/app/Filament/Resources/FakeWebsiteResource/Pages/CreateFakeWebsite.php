<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Resources\FakeWebsiteResource\Pages;

use App\Filament\Resources\FakeWebsiteResource;
use Filament\Resources\Pages\CreateRecord;

class CreateFakeWebsite extends CreateRecord
{
    protected static string $resource = FakeWebsiteResource::class;
}
