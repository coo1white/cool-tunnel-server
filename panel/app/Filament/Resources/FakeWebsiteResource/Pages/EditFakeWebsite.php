<?php

declare(strict_types=1);

namespace App\Filament\Resources\FakeWebsiteResource\Pages;

use App\Filament\Resources\FakeWebsiteResource;
use Filament\Actions;
use Filament\Resources\Pages\EditRecord;

class EditFakeWebsite extends EditRecord
{
    protected static string $resource = FakeWebsiteResource::class;

    protected function getHeaderActions(): array
    {
        return [Actions\DeleteAction::make()];
    }
}
