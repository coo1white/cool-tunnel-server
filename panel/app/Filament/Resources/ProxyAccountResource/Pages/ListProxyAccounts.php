<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Resources\ProxyAccountResource\Pages;

use App\Filament\Resources\ProxyAccountResource;
use Filament\Actions;
use Filament\Resources\Pages\ListRecords;

class ListProxyAccounts extends ListRecords
{
    protected static string $resource = ProxyAccountResource::class;

    protected function getHeaderActions(): array
    {
        return [Actions\CreateAction::make()];
    }
}
