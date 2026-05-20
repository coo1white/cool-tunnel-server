<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Resources\ProxyAccountResource\Pages;

use App\Filament\Resources\ProxyAccountResource;
use App\Support\SingBoxProtocolCatalog;
use Filament\Actions;
use Filament\Resources\Pages\EditRecord;
use Illuminate\Validation\ValidationException;

class EditProxyAccount extends EditRecord
{
    protected static string $resource = ProxyAccountResource::class;

    protected function getHeaderActions(): array
    {
        return [Actions\DeleteAction::make()];
    }

    protected function mutateFormDataBeforeSave(array $data): array
    {
        $protocols = SingBoxProtocolCatalog::normaliseSelected(
            $data['enabled_protocols'] ?? null,
            defaultWhenEmpty: false,
        );
        $invalidProtocols = SingBoxProtocolCatalog::invalidKeys($data['enabled_protocols'] ?? null);
        if ($invalidProtocols !== []) {
            throw ValidationException::withMessages([
                'enabled_protocols' => 'Unknown sing-box protocol selection: '.implode(', ', $invalidProtocols),
            ]);
        }
        if (! SingBoxProtocolCatalog::hasRenderedProtocol($protocols)) {
            throw ValidationException::withMessages([
                'enabled_protocols' => 'Choose at least one rendered protocol. VLESS + Reality keeps this account startable today.',
            ]);
        }
        $data['enabled_protocols'] = $protocols;

        return $data;
    }
}
