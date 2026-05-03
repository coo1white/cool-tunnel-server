<?php

namespace App\Filament\Resources\ProxyAccountResource\Pages;

use App\Filament\Resources\ProxyAccountResource;
use Filament\Actions;
use Filament\Resources\Pages\EditRecord;

class EditProxyAccount extends EditRecord
{
    protected static string $resource = ProxyAccountResource::class;

    protected function getHeaderActions(): array
    {
        return [Actions\DeleteAction::make()];
    }
}
